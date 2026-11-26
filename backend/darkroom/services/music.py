"""
Music and sound cues: where a library track sits in the edit, how loud it is,
and how far it gets out of the way while someone is talking.

Three ideas hold the design together:

**Cues are anchored in source time** (`at`/`until` on the joined recording), so
they move with the content as speech is cut, exactly like chapters.  Each cue is
resolved to an output time through the same kept ranges the renderer concatenates.

**Levels are relative to the voice.** Every library track's integrated loudness
is measured at import, and the speech mix is normalised to a known loudness, so a
cue's `gain_db` means "this far under the voice" rather than "this much of
whatever the file happened to be".  −12 dB sounds the same under every voice.

**Ducking comes from the transcript, not from a compressor.** We know to the word
where speech is, so the music dips *before* a word starts and comes back up after
a phrase ends, by an exact number of dB, with no pumping on breaths or room
noise.  The dip is computed here as a gain envelope, written out as raw floats and
multiplied into the music by FFmpeg's `amultiply`.
"""
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import library

# Cue fields and their defaults. A bed is the common case: quiet, looping,
# ducked under speech, fading in and out.
CUE_DEFAULTS = {
    "track": "music",
    "kind": "bed",          # bed | intro | outro | sfx
    "at": 0.0,              # source seconds (bed, sfx)
    "until": None,          # source seconds (bed); None runs to the end
    "length": None,         # output seconds (intro, outro, sfx); None uses the whole track
    "gain_db": -12.0,       # level relative to the voice
    "duck": True,
    "duck_db": -9.0,        # further reduction while someone is talking
    "loop": True,
    "fade_in": 1.0,
    "fade_out": 2.0,
}

KINDS = ("bed", "intro", "outro", "sfx")

DEFAULT_TRACKS = [{"id": "music", "name": "Music", "gain_db": 0.0, "muted": False}]

# Ducking shape. The dip starts before the word so the voice is never the thing
# that pushes the music down, and holds through the gaps inside a sentence.
DUCK_LOOKAHEAD = 0.25
DUCK_HOLD = 0.6
DUCK_FADE_DOWN = 0.12
DUCK_FADE_UP = 0.5

# The gain envelope only has to carry ramps of ~0.1 s, so 1 kHz is plenty; an
# hour of it is 14 MB of floats that FFmpeg resamples up to the mix rate.
ENV_RATE = 1000

_MIN_CUE = 0.05  # output seconds — shorter cues are dropped
_SAMPLE_RATE = 48000
STEREO = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


# ── Project data ──────────────────────────────────────────────────────────────

def sound_tracks(project: dict) -> list[dict]:
    return project.get("sound_tracks") or DEFAULT_TRACKS


def sound_cues(project: dict) -> list[dict]:
    """The project's cues with every field filled in."""
    return [{**CUE_DEFAULTS, **cue} for cue in project.get("sound_cues") or []]


# ── Intervals ─────────────────────────────────────────────────────────────────

def merge_spans(spans: list[tuple[float, float]], gap: float = 0.0) -> list[tuple[float, float]]:
    """Sort spans and join any that overlap or sit within `gap` of each other."""
    merged: list[tuple[float, float]] = []
    for start, end in sorted(spans):
        if merged and start - merged[-1][1] <= gap:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def speech_spans(segments: list[dict]) -> list[tuple[float, float]]:
    """Source-time spans where someone is talking, from the merged transcript."""
    spans: list[tuple[float, float]] = []
    for seg in segments or []:
        words = seg.get("words") or []
        if words:
            spans.extend((w["start"], w["end"]) for w in words
                         if w.get("end", 0.0) > w.get("start", 0.0))
        elif seg.get("end", 0.0) > seg.get("start", 0.0):
            spans.append((seg["start"], seg["end"]))
    return merge_spans(spans)


def to_output(spans: list[tuple[float, float]],
              ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """
    Map source-time spans into the output timeline, keeping only the parts that
    survive the edit. A span straddling a cut comes back as two spans.
    """
    out: list[tuple[float, float]] = []
    spans = sorted(spans)
    offset = 0.0
    first = 0
    for r_start, r_end in ranges:
        while first < len(spans) and spans[first][1] <= r_start:
            first += 1
        i = first
        while i < len(spans) and spans[i][0] < r_end:
            start = max(spans[i][0], r_start)
            end = min(spans[i][1], r_end)
            if end > start:
                out.append((offset + start - r_start, offset + end - r_start))
            i += 1
        offset += r_end - r_start
    return merge_spans(out)


def snap_to_output(t: float, ranges: list[tuple[float, float]]) -> float | None:
    """
    Source time → output time, moving a cut moment forward to where the edit
    resumes (so a cue anchored inside a cut lands on the next kept frame).
    Returns None for a time past the end of the edit.
    """
    offset = 0.0
    for r_start, r_end in ranges:
        if t < r_end:
            return offset + max(t - r_start, 0.0)
        offset += r_end - r_start
    return None


# ── Ducking ───────────────────────────────────────────────────────────────────

def duck_spans(speech: list[tuple[float, float]], limit: float) -> list[tuple[float, float]]:
    """Output-time spans the music should be held down over."""
    return merge_spans([(max(0.0, s - DUCK_LOOKAHEAD), min(limit, e + DUCK_HOLD))
                        for s, e in speech if s < limit])


def duck_envelope(spans: list[tuple[float, float]], duck_db: float, duration: float,
                  rate: int = ENV_RATE) -> np.ndarray:
    """
    A gain curve (1.0 → the ducked gain → 1.0) covering `duration` seconds.

    The curve runs a little past the edit so FFmpeg never multiplies the tail of
    a cue by a missing sample.
    """
    n = max(1, math.ceil((duration + 2.0) * rate))
    env = np.ones(n, dtype=np.float32)
    gain = 10 ** (duck_db / 20)
    for start, end in spans:
        total = end - start
        if total <= 0:
            continue
        down, up = DUCK_FADE_DOWN, DUCK_FADE_UP
        if down + up > total:  # a short dip never reaches the full depth's hold
            scale = total / (down + up)
            down, up = down * scale, up * scale
        i0, i1 = max(0, int(start * rate)), min(n, math.ceil(end * rate))
        if i1 <= i0:
            continue
        t = np.arange(i0, i1, dtype=np.float64) / rate
        curve = np.interp(t, [start, start + down, end - up, end], [1.0, gain, gain, 1.0])
        env[i0:i1] = np.minimum(env[i0:i1], curve.astype(np.float32))
    return env


def write_envelope(env: np.ndarray, path: Path) -> Path:
    """Raw little-endian floats — fed to FFmpeg as `-f f32le -ar ENV_RATE -ac 1`."""
    path.write_bytes(env.astype("<f4").tobytes())
    return path


# ── Planning ──────────────────────────────────────────────────────────────────

@dataclass
class ResolvedCue:
    """A cue placed on the output timeline, ready to become a filter chain."""
    path: str
    start: float          # output seconds
    length: float         # output seconds
    gain_db: float        # relative to the voice (cue gain + its track's gain)
    loudness: float | None  # the file's measured LUFS, None when it is silent
    duck_db: float | None   # None when the cue is not ducked
    loop: bool
    fade_in: float
    fade_out: float
    name: str = ""


@dataclass
class MusicPlan:
    cues: list[ResolvedCue] = field(default_factory=list)
    speech: list[tuple[float, float]] = field(default_factory=list)
    duration: float = 0.0

    def __bool__(self) -> bool:
        return bool(self.cues)

    @property
    def ducked(self) -> bool:
        return any(c.duck_db is not None for c in self.cues)


def plan_music(project: dict, ranges: list[tuple[float, float]],
               speech_duration: float | None = None) -> MusicPlan:
    """
    Resolve a project's cues against the edit it will be mixed into.

    `ranges` are the kept source ranges, in order (EDL keeps minus word cuts) —
    the same pieces the renderer concatenates. Cues on a muted track, cues whose
    library track has been deleted, and cues that fall past the end of the edit
    are dropped.
    """
    if speech_duration is None:
        speech_duration = sum(end - start for start, end in ranges)
    tracks = {t["id"]: t for t in sound_tracks(project)}
    plan = MusicPlan(duration=speech_duration)
    if speech_duration <= 0:
        return plan

    for cue in sound_cues(project):
        track = tracks.get(cue["track"])
        if track is None or track.get("muted"):
            continue
        item = library.get_track(cue.get("library_id", ""))
        if item is None:
            continue
        path = library.track_path(item)
        if not path.exists():
            continue
        placed = _place(cue, item, ranges, speech_duration)
        if placed is None:
            continue
        start, length, loop = placed
        plan.cues.append(ResolvedCue(
            path=str(path),
            start=start,
            length=length,
            gain_db=float(cue["gain_db"]) + float(track.get("gain_db") or 0.0),
            loudness=item.get("loudness"),
            duck_db=float(cue["duck_db"]) if cue["duck"] else None,
            loop=loop,
            fade_in=max(0.0, min(float(cue["fade_in"]), length / 2)),
            fade_out=max(0.0, min(float(cue["fade_out"]), length / 2)),
            name=item.get("name", ""),
        ))

    if plan.ducked:
        plan.speech = to_output(speech_spans(project.get("merged_transcript") or []), ranges)
    return plan


def _place(cue: dict, item: dict, ranges: list[tuple[float, float]],
           speech_duration: float) -> tuple[float, float, bool] | None:
    """(output start, length, loop) for one cue, or None if nothing of it is heard."""
    track_length = float(item.get("duration") or 0.0)
    if track_length <= 0:
        return None
    kind = cue["kind"] if cue["kind"] in KINDS else "bed"
    trimmed = float(cue["length"]) if cue["length"] else track_length

    if kind == "intro":
        start, length = 0.0, trimmed
    elif kind == "outro":
        length = trimmed
        start = max(0.0, speech_duration - length)
    else:
        mapped = snap_to_output(float(cue["at"]), ranges)
        if mapped is None:
            return None
        start = mapped
        if kind == "bed":
            until = cue["until"]
            end = speech_duration if until is None else snap_to_output(float(until), ranges)
            length = (speech_duration if end is None else end) - start
        else:  # sfx — a one-shot, as long as the file (or its trim)
            length = trimmed

    length = min(length, speech_duration - start)
    # Looping only makes sense while the file is shorter than the span it covers;
    # a cue that doesn't loop stops when the file runs out, so its fade-out lands.
    loop = bool(cue["loop"]) and track_length < length - 0.05
    if not loop:
        length = min(length, trimmed)
    if length < _MIN_CUE:
        return None
    return start, length, loop


# ── FFmpeg filter graph ───────────────────────────────────────────────────────

def build_music_filter(plan: MusicPlan, speech_label: str, first_input: int,
                       speech_lufs: float, tmp_dir: Path) -> tuple[list[str], list[str], str]:
    """
    Build the music half of a mix.

    Returns (input_args, filter_parts, out_label): extra FFmpeg inputs starting
    at index `first_input`, filter chains, and the label carrying speech plus
    music. `speech_label` must be the speech mix *after* it has been brought to
    `speech_lufs`, because cue levels are relative to it.
    """
    input_args: list[str] = []
    filter_parts: list[str] = []
    index = first_input
    plain: list[str] = []
    by_depth: dict[float, list[str]] = {}

    for i, cue in enumerate(plan.cues):
        if cue.loop:
            input_args += ["-stream_loop", "-1"]
        input_args += ["-i", cue.path]
        label = f"[cue{i}]"
        # A track with no measurable level (digital silence) gets the gain as-is.
        volume = speech_lufs + cue.gain_db - cue.loudness if cue.loudness is not None else cue.gain_db
        chain = [f"[{index}:a]{STEREO}",
                 f"atrim=duration={cue.length:.3f}",
                 "asetpts=PTS-STARTPTS",
                 f"volume={volume:.2f}dB"]
        if cue.fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={cue.fade_in:.3f}")
        if cue.fade_out > 0:
            chain.append(f"afade=t=out:st={cue.length - cue.fade_out:.3f}:d={cue.fade_out:.3f}")
        if cue.start > 0:
            chain.append(f"adelay={round(cue.start * 1000)}:all=1")
        filter_parts.append(",".join(chain) + label)
        index += 1
        if cue.duck_db is None:
            plain.append(label)
        else:
            by_depth.setdefault(cue.duck_db, []).append(label)

    ducked: list[str] = []
    for d, (depth, labels) in enumerate(sorted(by_depth.items())):
        summed = labels[0]
        if len(labels) > 1:
            summed = f"[duckable{d}]"
            filter_parts.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0{summed}")
        env = write_envelope(duck_envelope(duck_spans(plan.speech, plan.duration), depth, plan.duration),
                             tmp_dir / f"duck{d}.f32")
        input_args += ["-f", "f32le", "-ar", str(ENV_RATE), "-ac", "1", "-i", str(env)]
        filter_parts.append(f"[{index}:a]aresample={_SAMPLE_RATE},pan=stereo|c0=c0|c1=c0,"
                            f"aformat=sample_fmts=fltp[env{d}]")
        index += 1
        filter_parts.append(f"{summed}[env{d}]amultiply[ducked{d}]")
        ducked.append(f"[ducked{d}]")

    layers = [speech_label, *plain, *ducked]
    out_label = "[mixed]"
    # duration=first: the speech decides how long the output is, so a cue can
    # never stretch the episode past the video that goes with it.
    filter_parts.append(f"{''.join(layers)}amix=inputs={len(layers)}:duration=first"
                        f":normalize=0:dropout_transition=0{out_label}")
    return input_args, filter_parts, out_label

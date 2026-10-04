"""
takes.py — recorded takes on disk: streaming chunks in, finalising, and joining
takes into the per-speaker tracks the editor and renderer already understand.

Layout inside a project directory:

    takes/take_001/mic_A.part        raw MediaRecorder output, appended while recording
    takes/take_001/mic_A.wav         finalised on Stop (or on recovery after a crash)
    takes/take_001/transcript.json   {participant_id: [segments]}, times relative to the take
    cam_A.wav                        all takes joined end to end, in the takes strip order
"""
import json
import re
import subprocess
from pathlib import Path

PARTICIPANT_IDS = ["A", "B", "C", "D"]
SAMPLE_RATE = 48000

_SOURCE_RE = re.compile(r"^mic_([A-D])$")
_TAKE_RE = re.compile(r"^take_(\d{3,})$")


class ChunkOffsetError(Exception):
    """The chunk doesn't continue the file: an earlier chunk was lost."""

    def __init__(self, size: int):
        super().__init__(f"Expected a chunk at byte {size}")
        self.size = size


def participant_for_source(source: str) -> str | None:
    """'mic_A' → 'A'; None for anything that isn't a microphone source."""
    m = _SOURCE_RE.match(source)
    return m.group(1) if m else None


def is_take_id(take_id: str) -> bool:
    return bool(_TAKE_RE.match(take_id))


def next_take_id(takes_dir: Path) -> str:
    """Never reuses the number of a deleted take, so stale requests can't hit a new one."""
    numbers = [int(m.group(1)) for d in takes_dir.glob("take_*") if (m := _TAKE_RE.match(d.name))]
    return f"take_{max(numbers, default=0) + 1:03d}"


def append_chunk(path: Path, offset: int, data: bytes) -> int:
    """
    Append `data` to `path` if it starts where the file currently ends.
    A resend of a chunk that already landed (the response was lost) is accepted
    and ignored. Returns the file size afterwards.
    """
    size = path.stat().st_size if path.exists() else 0
    if offset == size:
        with open(path, "ab") as f:
            f.write(data)
            f.flush()
        return size + len(data)
    if offset + len(data) <= size:
        return size
    raise ChunkOffsetError(size)


def probe_duration(path: Path) -> float:
    cmd = ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
        return float(out)
    except (ValueError, subprocess.TimeoutExpired, FileNotFoundError):
        return 0.0


def _to_wav(src: Path, dst: Path) -> None:
    # Mono 48 kHz PCM: lossless, and identical across tracks so joining is simple.
    # Decoding stops cleanly at a truncated final cluster, which is what a crash leaves.
    tmp = dst.with_suffix(".tmp.wav")
    cmd = ["ffmpeg", "-y", "-nostdin", "-v", "error", "-i", str(src), "-vn",
           "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(tmp)]
    result = subprocess.run(cmd, capture_output=True, timeout=3600)
    if result.returncode != 0 or not tmp.exists() or probe_duration(tmp) <= 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(result.stderr.decode(errors="replace")[-500:] or "no audio decoded")
    tmp.replace(dst)


def finalise_take(take_dir: Path) -> dict:
    """
    Convert every raw recording in the take to WAV and remove the raw files.
    Safe to run again on a take that was partly finalised before a crash.

    Returns {"tracks": {participant_id: filename}, "duration": seconds, "errors": {...}}.
    """
    errors: dict[str, str] = {}
    for part in sorted(take_dir.glob("mic_*.part")):
        pid = participant_for_source(part.stem)
        if pid is None:
            continue
        if part.stat().st_size == 0:
            part.unlink()
            continue
        try:
            _to_wav(part, take_dir / f"mic_{pid}.wav")
            part.unlink()
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            errors[pid] = str(exc)

    tracks: dict[str, str] = {}
    duration = 0.0
    for wav in sorted(take_dir.glob("mic_*.wav")):
        pid = participant_for_source(wav.stem)
        if pid is None:
            continue
        tracks[pid] = wav.name
        duration = max(duration, probe_duration(wav))
    return {"tracks": tracks, "duration": round(duration, 3), "errors": errors}


def join_tracks(project_dir: Path, takes: list[dict], participants: list[dict]) -> list[dict]:
    """
    Join the takes end to end into one WAV per participant (cam_<id>.wav), in
    the given order. A participant missing from a take gets silence for it, and
    every take is padded or trimmed to its duration, so all tracks stay aligned.

    Returns the project's `speakers` list.
    """
    names = {p["id"]: p["name"] for p in participants}
    ids = [pid for pid in PARTICIPANT_IDS if any(pid in t["tracks"] for t in takes)]
    speakers = []
    for pid in ids:
        inputs: list[str] = []
        filters: list[str] = []
        for i, take in enumerate(takes):
            d = take["duration"]
            if pid in take["tracks"]:
                inputs += ["-i", str(project_dir / "takes" / take["id"] / take["tracks"][pid])]
            else:
                inputs += ["-f", "lavfi", "-t", str(d), "-i", f"anullsrc=r={SAMPLE_RATE}:cl=mono"]
            filters.append(f"[{i}:a]apad=whole_dur={d},atrim=end={d},asetpts=PTS-STARTPTS[a{i}]")
        labels = "".join(f"[a{i}]" for i in range(len(takes)))
        filters.append(f"{labels}concat=n={len(takes)}:v=0:a=1[out]")

        out = project_dir / f"cam_{pid}.wav"
        tmp = out.with_suffix(".tmp.wav")
        cmd = ["ffmpeg", "-y", "-nostdin", "-v", "error", *inputs,
               "-filter_complex", ";".join(filters), "-map", "[out]",
               "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(tmp)]
        result = subprocess.run(cmd, capture_output=True, timeout=3600)
        if result.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"Could not join takes for {names.get(pid, pid)}: "
                               f"{result.stderr.decode(errors='replace')[-500:]}")
        tmp.replace(out)
        speakers.append({
            "id": pid,
            "name": names.get(pid) or f"Speaker {pid}",
            "file": out.name,
            "file_path": str(out),
        })
    return speakers


def read_take_transcript(take_dir: Path) -> dict[str, list]:
    path = take_dir / "transcript.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_take_transcript(take_dir: Path, transcripts: dict[str, list]) -> None:
    tmp = take_dir / "transcript.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(transcripts, f)
    tmp.replace(take_dir / "transcript.json")


def _shift(seg: dict, offset: float, name: str) -> dict:
    return {
        **seg,
        "speaker_name": name,
        "start": round(seg["start"] + offset, 3),
        "end": round(seg["end"] + offset, 3),
        "words": [
            {**w, "start": round(w["start"] + offset, 3), "end": round(w["end"] + offset, 3)}
            for w in seg.get("words", [])
        ],
    }


def combine_transcripts(
    takes: list[dict],
    take_transcripts: dict[str, dict[str, list]],
    participants: list[dict],
) -> tuple[dict[str, list], list[dict], list[dict]]:
    """
    Shift each take's transcript by where the take starts on the joined
    timeline. Nothing is re-transcribed, so reordering takes is cheap.

    Returns (transcripts per speaker, merged transcript, take boundaries).
    """
    names = {p["id"]: p["name"] for p in participants}
    per_speaker: dict[str, list] = {}
    boundaries = []
    offset = 0.0
    for take in takes:
        for pid, segs in take_transcripts.get(take["id"], {}).items():
            name = names.get(pid) or f"Speaker {pid}"
            per_speaker.setdefault(pid, []).extend(_shift(s, offset, name) for s in segs)
        end = round(offset + take["duration"], 3)
        boundaries.append({"take_id": take["id"], "start": round(offset, 3), "end": end})
        offset = end

    merged = sorted((s for segs in per_speaker.values() for s in segs), key=lambda s: s["start"])
    return per_speaker, merged, boundaries

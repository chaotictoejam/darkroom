"""
What a DarkRelay episode bundle must satisfy, checked from the files alone.

Mirrors DarkRelay's rules (chaotictoejam/darkrelay, packages/core/src/bundle.ts
and model.ts: classifyBundle, EpisodeInput, YouTubeCopy, Chapters,
validateChapters) plus what the files themselves must be for podcast apps and
YouTube: real MP3/MP4/PNG/JPEG content, well-formed WebVTT, SRT and Podcasting
2.0 JSON transcripts, and timings that fit inside the audio.

`bundle_problems(dir)` returns every problem found, so a test can assert it's
empty and show all of them when it isn't.
"""
import json
import re
import subprocess
from pathlib import Path

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
# zod's z.iso.datetime({ offset: true })
ISO_WITH_OFFSET = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$")
EPISODE_KEYS = {"schemaVersion", "show", "guid", "title", "description", "link", "pubDate",
                "durationSeconds", "episodeType", "season", "episode", "explicit", "persons",
                "keywords", "transcriptLanguage", "youtube", "status"}
KNOWN_FILES = {"episode.json", "audio.mp3", "audio.m4a", "video.mp4", "chapters.json",
               "cover.jpg", "cover.jpeg", "cover.png",
               "transcript.vtt", "transcript.srt", "transcript.json"}
YT_TITLE_MAX = 100
YT_DESCRIPTION_MAX_BYTES = 5000
# The MP3 encoder pads a little; the edit's length and the file's differ by milliseconds
DURATION_TOLERANCE = 1.0
TIMING_TOLERANCE = 0.05

_VTT_TIME = r"(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})"
_SRT_TIME = r"(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})"


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format",
                          str(path)], capture_output=True, text=True)
    return json.loads(out.stdout or "{}")


def _seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_files(names: list[str]) -> list[str]:
    """classifyBundle: only files DarkRelay knows, one per role, and media to publish."""
    problems = [f"{n}: DarkRelay ignores this file" for n in names if n.lower() not in KNOWN_FILES]
    lower = {n.lower() for n in names}
    if "episode.json" not in lower:
        problems.append("episode.json is missing")
    for role, options in (("audio", {"audio.mp3", "audio.m4a"}),
                          ("cover", {"cover.jpg", "cover.jpeg", "cover.png"})):
        if len(lower & options) > 1:
            problems.append(f"More than one {role} file")
    if not lower & {"audio.mp3", "audio.m4a", "video.mp4"}:
        problems.append("No audio or video")
    return problems


def check_episode(ep: dict) -> list[str]:
    """EpisodeInput (schemaVersion 1) and YouTubeCopy."""
    p: list[str] = []
    unknown = set(ep) - EPISODE_KEYS
    if unknown:
        p.append(f"episode.json: unknown fields {sorted(unknown)}")
    if ep.get("schemaVersion") != 1:
        p.append("episode.json: schemaVersion must be 1")
    if not isinstance(ep.get("show"), str) or not SLUG.match(ep["show"]):
        p.append("episode.json: show is not a valid slug")
    for key in ("guid", "title", "description"):
        if not isinstance(ep.get(key), str) or not ep[key]:
            p.append(f"episode.json: {key} must be a non-empty string")
    if "pubDate" in ep and not (isinstance(ep["pubDate"], str) and ISO_WITH_OFFSET.match(ep["pubDate"])):
        p.append(f"episode.json: pubDate {ep['pubDate']!r} is not ISO 8601 with an offset")
    if not _is_int(ep.get("durationSeconds")) or ep["durationSeconds"] <= 0:
        p.append("episode.json: durationSeconds must be a positive whole number")
    if ep.get("episodeType", "full") not in ("full", "trailer", "bonus"):
        p.append("episode.json: episodeType must be full, trailer or bonus")
    for key in ("season", "episode"):
        if key in ep and (not _is_int(ep[key]) or ep[key] <= 0):
            p.append(f"episode.json: {key} must be a positive whole number")
    if "explicit" in ep and not isinstance(ep["explicit"], bool):
        p.append("episode.json: explicit must be true or false")
    if not isinstance(ep.get("keywords", []), list) or not all(isinstance(k, str) for k in ep.get("keywords", [])):
        p.append("episode.json: keywords must be a list of strings")
    for person in ep.get("persons", []):
        if not isinstance(person, dict) or not person.get("name"):
            p.append("episode.json: every person needs a name")
    if "transcriptLanguage" in ep and not isinstance(ep["transcriptLanguage"], str):
        p.append("episode.json: transcriptLanguage must be a string")
    if "status" in ep and ep["status"] not in ("published", "hidden"):
        p.append("episode.json: status must be published or hidden")
    yt = ep.get("youtube")
    if yt is not None:
        if not isinstance(yt, dict) or set(yt) - {"title", "description"}:
            p.append("episode.json: youtube may only have title and description")
        else:
            title, desc = yt.get("title"), yt.get("description")
            if title is not None and not (0 < len(title.strip()) <= YT_TITLE_MAX):
                p.append(f"episode.json: youtube.title must be 1 to {YT_TITLE_MAX} characters")
            if desc is not None and not (0 < len(desc.strip().encode("utf-8")) <= YT_DESCRIPTION_MAX_BYTES):
                p.append(f"episode.json: youtube.description must be 1 to {YT_DESCRIPTION_MAX_BYTES} bytes")
            if any(c in (title or "") + (desc or "") for c in "<>"):
                p.append("episode.json: YouTube does not allow < or >")
    return p


def check_audio(path: Path, ep: dict) -> tuple[list[str], float]:
    """A real MP3 with one audio stream, as long as durationSeconds says."""
    info = probe(path)
    streams = info.get("streams", [])
    p: list[str] = []
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if len(audio) != 1 or audio[0].get("codec_name") != "mp3":
        p.append(f"{path.name}: expected one MP3 audio stream, found {[s.get('codec_name') for s in streams]}")
    if any(s.get("codec_type") == "video" for s in streams):
        p.append(f"{path.name}: has a video stream")
    duration = float(info.get("format", {}).get("duration", 0))
    if _is_int(ep.get("durationSeconds")) and abs(ep["durationSeconds"] - duration) > DURATION_TOLERANCE:
        p.append(f"episode.json: durationSeconds {ep['durationSeconds']} but the audio is {duration:.2f} s")
    return p, duration


def _check_cues(name: str, cues: list[tuple[float, float, str]], duration: float) -> list[str]:
    p: list[str] = []
    if not cues:
        p.append(f"{name}: no cues")
    last_start = 0.0
    for i, (start, end, text) in enumerate(cues, 1):
        if end <= start:
            p.append(f"{name} cue {i}: ends at or before it starts ({start} → {end})")
        if start < last_start:
            p.append(f"{name} cue {i}: starts before the cue above it")
        if end > duration + TIMING_TOLERANCE:
            p.append(f"{name} cue {i}: ends at {end}, after the audio ({duration:.3f} s)")
        if not text.strip():
            p.append(f"{name} cue {i}: no text")
        last_start = start
    return p


def parse_vtt(text: str) -> tuple[list[tuple[float, float, str]], list[str]]:
    """WebVTT cues (start, end, text without the voice tag) and format problems."""
    p: list[str] = []
    if not text.startswith("WEBVTT"):
        p.append("transcript.vtt: must start with WEBVTT")
    cues = []
    for block in re.split(r"\n\s*\n", text.strip())[1:]:
        lines = block.split("\n")
        m = re.fullmatch(f"{_VTT_TIME} --> {_VTT_TIME}", lines[0])
        if not m:
            p.append(f"transcript.vtt: bad timing line {lines[0]!r}")
            continue
        body = "\n".join(lines[1:])
        voice = re.match(r"<v ([^>]+)>", body)
        rest = body[voice.end():] if voice else body
        if "<" in rest or ">" in rest or "-->" in rest:
            p.append(f"transcript.vtt: unescaped markup in {body!r}")
        if re.search(r"&(?!amp;|lt;|gt;|nbsp;|lrm;|rlm;)", rest):
            p.append(f"transcript.vtt: unescaped & in {body!r}")
        g = m.groups()
        cues.append((_seconds(*g[:4]), _seconds(*g[4:]), rest))
    return cues, p


def parse_srt(text: str) -> tuple[list[tuple[float, float, str]], list[str]]:
    p: list[str] = []
    cues = []
    for i, block in enumerate(re.split(r"\n\s*\n", text.strip()), 1):
        lines = block.split("\n")
        if lines[0] != str(i):
            p.append(f"transcript.srt: cue {i} is numbered {lines[0]!r}")
        m = re.fullmatch(f"{_SRT_TIME} --> {_SRT_TIME}", lines[1] if len(lines) > 1 else "")
        if not m:
            p.append(f"transcript.srt: bad timing line in cue {i}")
            continue
        g = m.groups()
        cues.append((_seconds(*g[:4]), _seconds(*g[4:]), "\n".join(lines[2:])))
    return cues, p


def parse_json_transcript(data: dict) -> tuple[list[tuple[float, float, str]], list[str]]:
    """Podcasting 2.0 JSON transcript."""
    p: list[str] = []
    if not isinstance(data.get("version"), str):
        p.append("transcript.json: version must be a string")
    cues = []
    for i, seg in enumerate(data.get("segments") or [], 1):
        if not (_is_number(seg.get("startTime")) and _is_number(seg.get("endTime"))):
            p.append(f"transcript.json segment {i}: startTime and endTime must be numbers")
            continue
        if "speaker" in seg and not isinstance(seg["speaker"], str):
            p.append(f"transcript.json segment {i}: speaker must be a string")
        cues.append((seg["startTime"], seg["endTime"], seg.get("body") or ""))
    return cues, p


def check_transcripts(bundle: Path, duration: float) -> list[str]:
    """Each transcript is well formed, fits the audio, and all of them agree."""
    p: list[str] = []
    found = {}
    if (bundle / "transcript.vtt").exists():
        found["vtt"] = parse_vtt((bundle / "transcript.vtt").read_text(encoding="utf-8"))
    if (bundle / "transcript.srt").exists():
        found["srt"] = parse_srt((bundle / "transcript.srt").read_text(encoding="utf-8"))
    if (bundle / "transcript.json").exists():
        found["json"] = parse_json_transcript(json.loads((bundle / "transcript.json").read_text(encoding="utf-8")))
    for kind, (cues, problems) in found.items():
        p += problems + _check_cues(f"transcript.{kind}", cues, duration)
    timings = {kind: [(round(s, 3), round(e, 3)) for s, e, _ in cues] for kind, (cues, _) in found.items()}
    if len({json.dumps(t) for t in timings.values()}) > 1:
        p.append("transcripts: the formats disagree on cue timings")
    return p


def check_chapters(data: dict, duration: float) -> list[str]:
    """Chapters and validateChapters, plus every chapter inside the audio."""
    p: list[str] = []
    if not isinstance(data.get("version"), str):
        p.append("chapters.json: version must be a string")
    chapters = data.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        return p + ["chapters.json: needs at least one chapter"]
    times = []
    for i, ch in enumerate(chapters):
        t = ch.get("startTime")
        if not _is_number(t) or t < 0:
            p.append(f"chapters.json chapters.{i}.startTime: must be a number ≥ 0")
            continue
        if "title" in ch and not isinstance(ch["title"], str):
            p.append(f"chapters.json chapters.{i}.title: must be a string")
        if not (ch.get("title") or "").strip():
            p.append(f"chapters.json chapters.{i}: no title")
        if t >= duration:
            p.append(f"chapters.json chapters.{i}: starts at {t}, after the audio ends")
        times.append(t)
    if times != sorted(times):
        p.append("chapters.json: chapters must be in startTime order")
    if len(set(times)) != len(times):
        p.append("chapters.json: two chapters start at the same time")
    return p


def check_cover(path: Path) -> list[str]:
    """The file is the image type its name says."""
    head = path.read_bytes()[:8]
    is_png, is_jpeg = head.startswith(b"\x89PNG\r\n\x1a\n"), head.startswith(b"\xff\xd8\xff")
    if path.suffix.lower() == ".png" and not is_png:
        return [f"{path.name}: is not a PNG"]
    if path.suffix.lower() in (".jpg", ".jpeg") and not is_jpeg:
        return [f"{path.name}: is not a JPEG"]
    return []


def cover_recommendations(path: Path) -> list[str]:
    """Apple Podcasts: square, 1400 to 3000 px. Not enforced by DarkRelay."""
    video = next(s for s in probe(path)["streams"] if s.get("codec_type") == "video")
    w, h = video["width"], video["height"]
    out = []
    if w != h:
        out.append("not square")
    if not 1400 <= min(w, h) <= max(w, h) <= 3000:
        out.append("outside 1400 to 3000 px")
    return out


def check_video(path: Path, duration: float) -> list[str]:
    """H.264 + AAC in MP4, as long as the audio."""
    info = probe(path)
    codecs = {s.get("codec_type"): s.get("codec_name") for s in info.get("streams", [])}
    p = []
    if "mp4" not in info.get("format", {}).get("format_name", ""):
        p.append("video.mp4: not an MP4 container")
    if codecs.get("video") != "h264" or codecs.get("audio") != "aac":
        p.append(f"video.mp4: expected H.264 video and AAC audio, found {codecs}")
    video_duration = float(info.get("format", {}).get("duration", 0))
    if abs(video_duration - duration) > DURATION_TOLERANCE:
        p.append(f"video.mp4: {video_duration:.2f} s but the audio is {duration:.2f} s")
    return p


def bundle_problems(bundle: Path) -> list[str]:
    """Every way the bundle in `bundle` falls short of what DarkRelay and podcast apps need."""
    names = sorted(f.name for f in bundle.iterdir())
    problems = check_files(names)
    if "episode.json" not in names:
        return problems
    ep = json.loads((bundle / "episode.json").read_text(encoding="utf-8"))
    problems += check_episode(ep)
    duration = float(ep.get("durationSeconds") or 0)
    if "audio.mp3" in names:
        audio_problems, duration = check_audio(bundle / "audio.mp3", ep)
        problems += audio_problems
    problems += check_transcripts(bundle, duration)
    if "chapters.json" in names:
        problems += check_chapters(json.loads((bundle / "chapters.json").read_text(encoding="utf-8")), duration)
    for name in names:
        if name.startswith("cover."):
            problems += check_cover(bundle / name)
    if "video.mp4" in names:
        problems += check_video(bundle / "video.mp4", duration)
    return problems

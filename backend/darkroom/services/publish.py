"""
DarkRelay episode bundles: everything `darkrelay publish <dir>` needs, written locally.

A bundle is a folder with `episode.json`, `audio.mp3`, transcripts and chapters
re-timed to the edit, and optionally `cover.jpg`/`cover.png` and `video.mp4`.
The format is DarkRelay's (`packages/core/src/bundle.ts` in the darkrelay repo).
Nothing here sends anything off the machine; the user publishes the folder with
the DarkRelay CLI into their own AWS account.
"""
import html
import json
import re
import shutil
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from .renderer import _apply_word_cuts, get_video_info, render_project

# DarkRelay's limits (packages/core/src/model.ts)
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
YT_TITLE_MAX = 100
YT_DESCRIPTION_MAX_BYTES = 5000
EPISODE_TYPES = ("full", "trailer", "bonus")

# Caption cues: short enough to read, long enough not to flicker
_CUE_MAX_SECONDS = 6.0
_CUE_MAX_CHARS = 84
_CUE_PAUSE = 1.0
_CUE_MIN_SECONDS = 0.1

BUNDLE_DIR = "darkrelay"
BUNDLE_ZIP = "darkrelay.zip"


# ── Edited time ───────────────────────────────────────────────────────────────

def kept_ranges(project: dict) -> list[tuple[float, float]]:
    """Source ranges that make it into the export, in order (EDL keeps minus word cuts)."""
    segs = [s for s in project["edl"]["segments"] if s.get("keep", True)]
    pieces = _apply_word_cuts(segs, project.get("word_cuts") or [])
    return [(p["start"], p["end"]) for p in pieces]


def to_edited(t: float, ranges: list[tuple[float, float]]) -> float | None:
    """Source time → time in the exported file, or None if `t` was cut."""
    out = 0.0
    for start, end in ranges:
        if t < start:
            return None
        if t <= end:
            return out + t - start
        out += end - start
    return None


def _snap_to_edited(t: float, ranges: list[tuple[float, float]]) -> float | None:
    """Like to_edited, but a cut time moves forward to where the edit resumes (None after the end)."""
    out = 0.0
    for start, end in ranges:
        if t < end:
            return out + max(t - start, 0.0)
        out += end - start
    return None


def _piece_at(t: float, ranges: list[tuple[float, float]]) -> tuple[float, float, float] | None:
    """(edited time where it starts, start, end) of the kept piece holding source time `t`."""
    out = 0.0
    for start, end in ranges:
        if start <= t <= end:
            return out, start, end
        out += end - start
    return None


def edited_words(project: dict) -> list[dict]:
    """
    Every word the listener hears, with edited-time start/end and its speaker.
    Words in a cut or a mute are left out: muted words are silent in the export.
    """
    ranges = kept_ranges(project)
    mutes = project.get("word_mutes") or []
    words: list[dict] = []
    for seg in project.get("merged_transcript") or []:
        for w in seg.get("words") or []:
            mid = (w["start"] + w["end"]) / 2
            if any(m["start"] <= mid <= m["end"] for m in mutes):
                continue
            piece = _piece_at(mid, ranges)
            if piece is None:
                continue
            offset, piece_start, piece_end = piece
            # A word straddling a cut keeps the part that is heard
            start = offset + max(w["start"], piece_start) - piece_start
            end = offset + min(w["end"], piece_end) - piece_start
            words.append({"text": w["word"].strip(), "start": start, "end": end,
                          "speaker": seg.get("speaker_name") or seg.get("speaker_id", "")})
    words = [w for w in words if w["text"]]
    words.sort(key=lambda w: w["start"])
    return words


def _cues(words: list[dict], duration: float | None = None) -> list[dict]:
    """
    Group words into caption cues, breaking on speaker changes, pauses and length.
    Every cue lasts at least _CUE_MIN_SECONDS and, given the audio's duration, ends inside it.
    """
    cues: list[dict] = []
    for w in words:
        cur = cues[-1] if cues else None
        if (cur is None or cur["speaker"] != w["speaker"]
                or w["start"] - cur["end"] > _CUE_PAUSE
                or w["end"] - cur["start"] > _CUE_MAX_SECONDS
                or len(cur["text"]) + 1 + len(w["text"]) > _CUE_MAX_CHARS):
            cues.append({"speaker": w["speaker"], "start": w["start"], "end": w["end"], "text": w["text"]})
        else:
            cur["text"] += " " + w["text"]
            cur["end"] = max(cur["end"], w["end"])
    prev_start = 0.0
    for c in cues:
        c["end"] = max(c["end"], c["start"] + _CUE_MIN_SECONDS)
        if duration is not None and c["end"] > duration:
            c["end"] = duration
            c["start"] = max(min(c["start"], duration - _CUE_MIN_SECONDS), prev_start, 0.0)
        prev_start = c["start"]
    return [c for c in cues if c["end"] > c["start"]]


def _timestamp(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def transcript_vtt(cues: list[dict]) -> str:
    lines = ["WEBVTT", ""]
    for c in cues:
        speaker = c["speaker"].replace(">", "").strip()
        text = html.escape(c["text"], quote=False)
        lines += [f"{_timestamp(c['start'], '.')} --> {_timestamp(c['end'], '.')}",
                  f"<v {speaker}>{text}" if speaker else text, ""]
    return "\n".join(lines)


def transcript_srt(cues: list[dict]) -> str:
    lines: list[str] = []
    for i, c in enumerate(cues, 1):
        text = f"{c['speaker']}: {c['text']}" if c["speaker"] else c["text"]
        lines += [str(i), f"{_timestamp(c['start'], ',')} --> {_timestamp(c['end'], ',')}", text, ""]
    return "\n".join(lines)


def transcript_json(cues: list[dict]) -> dict:
    """Podcasting 2.0 JSON transcript (podcastindex.org transcript spec)."""
    return {
        "version": "1.0.0",
        "segments": [
            {"speaker": c["speaker"], "startTime": round(c["start"], 3),
             "endTime": round(c["end"], 3), "body": c["text"]}
            for c in cues
        ],
    }


def chapters_json(project: dict, duration: float) -> dict | None:
    """
    Podcasting 2.0 JSON chapters. Chapters are stored in source time so they
    follow later edits; one inside a cut moves to where the edit resumes.
    """
    ranges = kept_ranges(project)
    out: list[dict] = []
    for ch in sorted(project["publish"].get("chapters") or [], key=lambda c: c["start"]):
        title = (ch.get("title") or "").strip()
        if not title:
            continue
        snapped = _snap_to_edited(ch["start"], ranges)
        if snapped is None or snapped >= duration:
            continue
        t = round(snapped, 3)
        if out and t <= out[-1]["startTime"]:
            out[-1] = {"startTime": out[-1]["startTime"], "title": title}
            continue
        out.append({"startTime": t, "title": title})
    if not out:
        return None
    return {"version": "1.2.0", "chapters": out}


# ── Episode details ───────────────────────────────────────────────────────────

def notes_html(notes: str) -> str:
    """Show notes as HTML. Plain text (no tags) becomes paragraphs."""
    notes = notes.strip()
    if re.search(r"<[a-zA-Z/][^>]*>", notes):
        return notes
    paras = [p.strip() for p in re.split(r"\n\s*\n", notes) if p.strip()]
    return "\n".join("<p>" + html.escape(p).replace("\n", "<br>") + "</p>" for p in paras)


def validate_details(details: dict) -> list[str]:
    """Problems that would make DarkRelay reject the bundle, in plain words."""
    errors: list[str] = []
    if not SLUG.match(details.get("show") or ""):
        errors.append("Show: use the show's DarkRelay slug (lowercase letters, numbers and dashes)")
    if not (details.get("title") or "").strip():
        errors.append("Title is required")
    if not (details.get("notes") or "").strip():
        errors.append("Show notes are required")
    if details.get("episode_type", "full") not in EPISODE_TYPES:
        errors.append(f"Episode type must be one of {', '.join(EPISODE_TYPES)}")
    for key, label in (("season", "Season"), ("episode", "Episode number")):
        v = details.get(key)
        if v is not None and (not isinstance(v, int) or v < 1):
            errors.append(f"{label} must be a whole number above 0")
    if details.get("pub_date"):
        try:
            if datetime.fromisoformat(details["pub_date"]).tzinfo is None:
                errors.append("Release time needs a time zone")
        except ValueError:
            errors.append("Release time is not a valid date and time")
    yt_title = (details.get("yt_title") or "").strip()
    if len(yt_title) > YT_TITLE_MAX:
        errors.append(f"YouTube title is over {YT_TITLE_MAX} characters")
    yt_desc = (details.get("yt_description") or "").strip()
    if len(yt_desc.encode("utf-8")) > YT_DESCRIPTION_MAX_BYTES:
        errors.append(f"YouTube description is over {YT_DESCRIPTION_MAX_BYTES} bytes")
    if any(c in yt_title + yt_desc for c in "<>"):
        errors.append("YouTube doesn't allow < or > in titles or descriptions")
    return errors


def episode_json(details: dict, duration: float, language: str | None) -> dict:
    """episode.json for DarkRelay (schemaVersion 1). Empty optional fields are left out."""
    ep: dict = {
        "schemaVersion": 1,
        "show": details["show"],
        "guid": details["guid"],
        "title": details["title"].strip(),
        "description": notes_html(details["notes"]),
        "durationSeconds": max(1, round(duration)),
        "episodeType": details.get("episode_type") or "full",
        "keywords": [k.strip() for k in details.get("keywords") or [] if k.strip()],
    }
    if details.get("pub_date"):
        # Python reads more ISO forms than DarkRelay does; write the one it reads
        ep["pubDate"] = datetime.fromisoformat(details["pub_date"]).isoformat(timespec="seconds")
    for key in ("season", "episode"):
        if details.get(key) is not None:
            ep[key] = details[key]
    if details.get("explicit") is not None:
        ep["explicit"] = details["explicit"]
    if language:
        ep["transcriptLanguage"] = language
    youtube = {k: v for k, v in (("title", (details.get("yt_title") or "").strip()),
                                 ("description", (details.get("yt_description") or "").strip())) if v}
    if youtube:
        ep["youtube"] = youtube
    return ep


def _cover_warnings(path: Path) -> list[str]:
    info = get_video_info(str(path))
    w, h = info["width"], info["height"]
    if w != h:
        return [f"Cover art is {w}×{h}; podcast apps expect a square image"]
    if w < 1400 or w > 3000:
        return [f"Cover art is {w}×{h}; Apple Podcasts asks for 1400 to 3000 pixels square"]
    return []


# ── Bundle ────────────────────────────────────────────────────────────────────

def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "episode"


def build_bundle(project: dict, projects_dir: Path, on_step=lambda msg, pct: None) -> dict:
    """
    Render the edit and write the bundle to output/darkrelay/, plus a zip of it.
    `project["publish"]["guid"]` must already be set. Returns the bundle summary
    saved as `publish.bundle`. Raises ValueError on invalid details.
    """
    details = project["publish"]
    errors = validate_details(details)
    if errors:
        raise ValueError("\n".join(errors))
    if not project.get("edl"):
        raise ValueError("Run AI analysis (or skip it) first: the bundle is made from the edit")

    project_dir = Path(projects_dir) / project["id"]
    output_dir = project_dir / "output"
    bundle_dir = output_dir / BUNDLE_DIR
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    bundle_dir.mkdir(parents=True)
    warnings: list[str] = []

    on_step("Rendering MP3…", 10)
    results = render_project(project, ["mp3"], projects_dir)
    if results["mp3"]["status"] != "done":
        raise RuntimeError(f"MP3 render failed: {results['mp3'].get('error')}")
    shutil.copy2(output_dir / "fullEdit.mp3", bundle_dir / "audio.mp3")
    duration = get_video_info(str(bundle_dir / "audio.mp3"))["duration"]

    if project.get("project_type") != "podcast" and details.get("include_video", True):
        on_step("Rendering video…", 35)
        results = render_project(project, ["fullEdit"], projects_dir)
        if results["fullEdit"]["status"] != "done":
            raise RuntimeError(f"Video render failed: {results['fullEdit'].get('error')}")
        shutil.copy2(output_dir / "fullEdit.mp4", bundle_dir / "video.mp4")

    on_step("Writing transcript and chapters…", 85)
    cues = _cues(edited_words(project), duration)
    if cues:
        (bundle_dir / "transcript.vtt").write_text(transcript_vtt(cues), encoding="utf-8")
        (bundle_dir / "transcript.srt").write_text(transcript_srt(cues), encoding="utf-8")
        (bundle_dir / "transcript.json").write_text(
            json.dumps(transcript_json(cues), indent=2, ensure_ascii=False), encoding="utf-8")
    else:
        warnings.append("No transcript words survive the edit, so the bundle has no transcript")

    chapters = chapters_json(project, duration)
    if chapters:
        (bundle_dir / "chapters.json").write_text(
            json.dumps(chapters, indent=2, ensure_ascii=False), encoding="utf-8")
        if chapters["chapters"][0]["startTime"] > 0:
            warnings.append("The first chapter doesn't start at 0:00; YouTube needs one there")

    if details.get("cover"):
        cover = project_dir / details["cover"]
        if cover.exists():
            shutil.copy2(cover, bundle_dir / f"cover{cover.suffix.lower()}")
            warnings += _cover_warnings(cover)
        else:
            warnings.append("Cover art file is missing; upload it again")

    language = project.get("transcribe_language") or None
    episode = episode_json(details, duration, language)
    (bundle_dir / "episode.json").write_text(
        json.dumps(episode, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    on_step("Zipping bundle…", 95)
    zip_path = output_dir / BUNDLE_ZIP
    folder = _safe_name(f"{details['show']}-{details['title']}")[:80]
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(bundle_dir.iterdir()):
            # Media is already compressed; storing it is as small and much faster
            kind = zipfile.ZIP_STORED if f.suffix in (".mp3", ".mp4", ".jpg", ".jpeg", ".png") \
                else zipfile.ZIP_DEFLATED
            zf.write(f, f"{folder}/{f.name}", compress_type=kind)

    return {
        "created_at": datetime.now().astimezone().isoformat(),
        "dir": str(bundle_dir.resolve()),
        "files": sorted(f.name for f in bundle_dir.iterdir()),
        "url": f"/projects/{project['id']}/files/output/{BUNDLE_ZIP}",
        "folder": folder,
        "duration": duration,
        "warnings": warnings,
    }


def new_guid() -> str:
    """Episode GUIDs are set once and never change, as DarkRelay requires."""
    return str(uuid.uuid4())

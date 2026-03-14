"""
renderer.py — FFmpeg rendering logic
"""

import json
import os
import shutil
import subprocess
from pathlib import Path


# ---------------------------------------------------------------------------
# FFmpeg availability
# ---------------------------------------------------------------------------

def check_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def get_video_info(file_path: str) -> dict:
    """Return duration, width, height via ffprobe."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        file_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    data = json.loads(result.stdout)
    duration = float(data["format"].get("duration", 0))
    width, height = 1920, 1080
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            width = int(stream.get("width", 1920))
            height = int(stream.get("height", 1080))
            break
    return {"duration": duration, "width": width, "height": height}


# ---------------------------------------------------------------------------
# Core render dispatch
# ---------------------------------------------------------------------------

def render_project(project: dict, targets: list[str], projects_dir: Path) -> dict:
    """Render a project to the requested targets. Returns {target: result_dict}."""
    project_dir = Path(projects_dir) / project["id"]
    output_dir = project_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    edl = project["edl"]
    speakers_dict = {s["id"]: s for s in project["speakers"]}
    results = {}

    for target in targets:
        try:
            if target == "fullEdit":
                out = str(output_dir / "fullEdit.mp4")
                _render_fulledit(edl["segments"], speakers_dict, out)
                results["fullEdit"] = {
                    "status": "done",
                    "url": f"/projects/{project['id']}/files/output/fullEdit.mp4",
                    "filename": "fullEdit.mp4",
                }

            elif target == "vertical":
                out = str(output_dir / "vertical.mp4")
                _render_vertical(edl["segments"], speakers_dict, out)
                results["vertical"] = {
                    "status": "done",
                    "url": f"/projects/{project['id']}/files/output/vertical.mp4",
                    "filename": "vertical.mp4",
                }

            elif target == "short":
                clips = edl.get("clips", [])
                if not clips:
                    results["short"] = {"status": "error", "error": "No clips in EDL"}
                    continue
                clip = clips[0]
                out = str(output_dir / "short.mp4")
                _render_clip(clip, edl["segments"], speakers_dict, out, vertical=True)
                results["short"] = {
                    "status": "done",
                    "url": f"/projects/{project['id']}/files/output/short.mp4",
                    "filename": "short.mp4",
                }

        except subprocess.CalledProcessError as exc:
            results[target] = {"status": "error", "error": exc.stderr or str(exc)}
        except Exception as exc:
            results[target] = {"status": "error", "error": str(exc)}

    return results


# ---------------------------------------------------------------------------
# Render helpers
# ---------------------------------------------------------------------------

def _build_concat_filter(kept_segments: list[dict], speakers_dict: dict, vertical: bool = False):
    """
    Return (input_args, filter_complex, n_segments) for an ffmpeg concat.

    Each kept segment trims from the assigned camera's file, then all are
    concatenated into [outv][outa].
    """
    # Map camera ID → sequential ffmpeg input index
    unique_cams = []
    for seg in kept_segments:
        cam = seg.get("camera", "A")
        if cam in speakers_dict and cam not in unique_cams:
            unique_cams.append(cam)

    if not unique_cams:
        raise ValueError("No valid camera assignments found in kept segments")

    cam_to_idx = {cam: i for i, cam in enumerate(unique_cams)}
    input_args = []
    for cam in unique_cams:
        input_args.extend(["-i", speakers_dict[cam]["file_path"]])

    filter_parts = []
    stream_labels = []

    for i, seg in enumerate(kept_segments):
        cam = seg.get("camera", unique_cams[0])
        if cam not in cam_to_idx:
            cam = unique_cams[0]

        idx = cam_to_idx[cam]
        s, e = seg["start"], seg["end"]

        if vertical:
            # Scale to height 1920, crop center 1080 width → 1080×1920 (9:16)
            vf = (
                f"[{idx}:v]trim=start={s}:end={e},setpts=PTS-STARTPTS,"
                f"scale=-1:1920,crop=1080:1920[v{i}]"
            )
        else:
            # Scale to 1920×1080, letterbox if needed
            vf = (
                f"[{idx}:v]trim=start={s}:end={e},setpts=PTS-STARTPTS,"
                f"scale=1920:1080:force_original_aspect_ratio=decrease,"
                f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v{i}]"
            )

        af = f"[{idx}:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]"
        filter_parts.extend([vf, af])
        stream_labels.extend([f"[v{i}]", f"[a{i}]"])

    n = len(kept_segments)
    concat_str = "".join(stream_labels) + f"concat=n={n}:v=1:a=1[outv][outa]"
    filter_complex = ";".join(filter_parts) + ";" + concat_str

    return input_args, filter_complex, n


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, cmd, result.stderr)


def _render_fulledit(segments: list[dict], speakers_dict: dict, output_path: str) -> None:
    kept = [s for s in segments if s["keep"]]
    if not kept:
        raise ValueError("No kept segments to render")

    input_args, filter_complex, _ = _build_concat_filter(kept, speakers_dict, vertical=False)

    cmd = ["ffmpeg", "-y"]
    cmd.extend(input_args)
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ])
    _run_ffmpeg(cmd)


def _render_vertical(segments: list[dict], speakers_dict: dict, output_path: str) -> None:
    kept = [s for s in segments if s["keep"]]
    if not kept:
        raise ValueError("No kept segments to render")

    input_args, filter_complex, _ = _build_concat_filter(kept, speakers_dict, vertical=True)

    cmd = ["ffmpeg", "-y"]
    cmd.extend(input_args)
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ])
    _run_ffmpeg(cmd)


# ---------------------------------------------------------------------------
# Subtitle generation (ASS format, Submagic-style)
# ---------------------------------------------------------------------------

_ASS_HEADER = """\
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: word,Arial,95,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,5,0,2,60,60,200,1
Style: chunk,Arial,78,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,4,0,2,60,60,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

def _ass_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{int(s):02d}.{int((s % 1) * 100):02d}"


def _esc_ass(text: str) -> str:
    return text.replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def generate_ass(
    merged_transcript: list[dict],
    clips: list[dict],
    edl_segments: list[dict],
    style: str = "chunk",
) -> str:
    """
    Generate ASS subtitle content for a short composed of one or more clips.

    Handles cuts within clip windows — the output timestamps match what
    FFmpeg will actually render after removing cut segments.
    """
    if style == "none":
        return ""

    # Build ordered list of (src_start, src_end) pieces that will be rendered
    rendered_pieces = []
    for clip in clips:
        for seg in edl_segments:
            if not seg.get("keep", True):
                continue
            s = max(seg["start"], clip["start"])
            e = min(seg["end"], clip["end"])
            if e > s:
                rendered_pieces.append({"src_start": s, "src_end": e})

    if not rendered_pieces:
        return ""

    # Collect word-level events mapped to output timestamps
    all_words = []
    output_offset = 0.0
    for piece in rendered_pieces:
        for seg in merged_transcript:
            for w in seg.get("words", []):
                ws, we = w["start"], w["end"]
                if we > piece["src_start"] and ws < piece["src_end"]:
                    cs = max(ws, piece["src_start"])
                    ce = min(we, piece["src_end"])
                    word_text = w["word"].strip()
                    if word_text:
                        all_words.append({
                            "word": word_text,
                            "start": (cs - piece["src_start"]) + output_offset,
                            "end":   (ce - piece["src_start"]) + output_offset,
                        })
        output_offset += piece["src_end"] - piece["src_start"]

    if not all_words:
        return ""

    # Fallback: if no word timestamps, build words from segment text
    events = []
    pos = r"{\an2\pos(540,1650)}"  # bottom-center, inside lower third

    if style == "word":
        for w in all_words:
            events.append(
                f"Dialogue: 0,{_ass_time(w['start'])},{_ass_time(w['end'])},"
                f"word,,0,0,0,,{pos}{_esc_ass(w['word'].upper())}"
            )

    elif style == "chunk":
        chunk_size = 4
        for i in range(0, len(all_words), chunk_size):
            chunk = all_words[i:i + chunk_size]
            text = " ".join(w["word"].upper() for w in chunk)
            events.append(
                f"Dialogue: 0,{_ass_time(chunk[0]['start'])},{_ass_time(chunk[-1]['end'])},"
                f"chunk,,0,0,0,,{pos}{_esc_ass(text)}"
            )

    elif style == "karaoke":
        chunk_size = 4
        for i in range(0, len(all_words), chunk_size):
            chunk = all_words[i:i + chunk_size]
            # One event per word: show full group, highlight active word in yellow
            for j, active_w in enumerate(chunk):
                parts = []
                for k, w in enumerate(chunk):
                    word_up = _esc_ass(w["word"].upper())
                    if k == j:
                        parts.append(f"{{\\c&H0000FFFF&}}{word_up}{{\\c&H00FFFFFF&}}")
                    else:
                        parts.append(f"{{\\c&H80FFFFFF&}}{word_up}{{\\c&H00FFFFFF&}}")
                line = "  ".join(parts)
                events.append(
                    f"Dialogue: 0,{_ass_time(active_w['start'])},{_ass_time(active_w['end'])},"
                    f"chunk,,0,0,0,,{pos}{line}"
                )

    return _ASS_HEADER + "\n".join(events) + "\n"


def _ffmpeg_escape_path(path: str) -> str:
    """Escape a file path for use inside an FFmpeg filter string."""
    p = path.replace("\\", "/")
    # Escape drive-letter colon: C:/... → C\:/...
    if len(p) >= 2 and p[1] == ":":
        p = p[0] + "\\:" + p[2:]
    return p


# ---------------------------------------------------------------------------
# Custom short renderer (multi-clip + subtitle burn-in)
# ---------------------------------------------------------------------------

def render_short_custom(
    clips: list[dict],
    edl_segments: list[dict],
    speakers_dict: dict,
    subtitle_style: str,
    merged_transcript: list[dict],
    output_path: str,
    output_dir,
) -> None:
    """
    Render a short from one or more user-defined clip windows.

    clips          — [{start, end, label?}, ...]  (original-timeline timestamps)
    edl_segments   — full EDL segment list (kept + cut)
    subtitle_style — 'word' | 'chunk' | 'karaoke' | 'none'
    """
    # Resolve kept sub-segments within each clip window
    all_clip_segs = []
    for clip in clips:
        for seg in edl_segments:
            if not seg.get("keep", True):
                continue
            s = max(seg["start"], clip["start"])
            e = min(seg["end"], clip["end"])
            if e > s:
                all_clip_segs.append({**seg, "start": s, "end": e})

    if not all_clip_segs:
        raise ValueError("No kept segments found within the specified clip range(s).")

    input_args, filter_complex, _ = _build_concat_filter(all_clip_segs, speakers_dict, vertical=True)

    # Subtitle burn-in
    if subtitle_style and subtitle_style != "none":
        ass_content = generate_ass(merged_transcript, clips, edl_segments, subtitle_style)
        if ass_content:
            from pathlib import Path as _Path
            ass_path = str(_Path(output_dir) / "subtitles.ass")
            with open(ass_path, "w", encoding="utf-8") as f:
                f.write(ass_content)
            # Reroute the final video output through the ass filter
            filter_complex = filter_complex.replace("[outv][outa]", "[outv_presub][outa]")
            escaped = _ffmpeg_escape_path(ass_path)
            filter_complex += f";[outv_presub]ass=filename='{escaped}'[outv]"

    cmd = ["ffmpeg", "-y"]
    cmd.extend(input_args)
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ])
    _run_ffmpeg(cmd)


def _render_clip(clip: dict, segments: list[dict], speakers_dict: dict, output_path: str, vertical: bool = True) -> None:
    """Render a specific clip (e.g. Shorts candidate) by finding overlapping segments."""
    clip_start = clip["start"]
    clip_end = clip["end"]

    # Find segments that overlap with the clip window and are kept
    clip_segs = []
    for seg in segments:
        if not seg["keep"]:
            continue
        seg_start = max(seg["start"], clip_start)
        seg_end = min(seg["end"], clip_end)
        if seg_end > seg_start:
            clip_segs.append({**seg, "start": seg_start, "end": seg_end})

    if not clip_segs:
        raise ValueError(f"No kept segments overlap with clip window {clip_start}–{clip_end}")

    input_args, filter_complex, _ = _build_concat_filter(clip_segs, speakers_dict, vertical=vertical)

    cmd = ["ffmpeg", "-y"]
    cmd.extend(input_args)
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ])
    _run_ffmpeg(cmd)

"""
renderer.py — FFmpeg rendering logic
"""

import json
import os
import subprocess
from pathlib import Path


# ---------------------------------------------------------------------------
# FFmpeg availability
# ---------------------------------------------------------------------------

def check_ffmpeg() -> bool:
    try:
        r = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=10)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


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

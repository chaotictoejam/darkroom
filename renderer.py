"""
renderer.py — FFmpeg rendering logic
"""

import json
import os
import shutil
import subprocess
import tempfile
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
# Smart crop — face/body detection via OpenCV, center-crop fallback
# ---------------------------------------------------------------------------

# Module-level cache: video_path → (cx_ratio, cy_ratio)
# Ratios are 0.0–1.0 relative to original frame dimensions, so they survive
# any downstream scale operation.
_face_center_cache: dict[str, tuple[float, float]] = {}


def _detect_face_center_ratio(video_path: str) -> tuple[float, float]:
    """
    Sample 3 frames from video_path, run face + upper-body detection via OpenCV,
    and return (cx_ratio, cy_ratio) — face centre as a fraction of frame size.

    Falls back to (0.5, 0.5) — dead centre — if OpenCV is unavailable or no
    face/body is found.
    """
    if video_path in _face_center_cache:
        return _face_center_cache[video_path]

    default = (0.5, 0.5)

    try:
        import cv2
    except ImportError:
        _face_center_cache[video_path] = default
        return default

    info = get_video_info(video_path)
    duration = info["duration"]
    if duration <= 0:
        _face_center_cache[video_path] = default
        return default

    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    body_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_upperbody.xml"
    )

    sample_times = [duration * 0.2, duration * 0.5, duration * 0.8]
    centers = []

    for t in sample_times:
        tmp = tempfile.mktemp(suffix=".jpg")
        try:
            cmd = [
                "ffmpeg", "-y", "-ss", str(t), "-i", video_path,
                "-frames:v", "1", "-q:v", "3", tmp,
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=20)
            if r.returncode != 0:
                continue

            img = cv2.imread(tmp)
            if img is None:
                continue

            h_img, w_img = img.shape[:2]
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

            # Face detection
            faces = face_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
            )
            if len(faces):
                x, y, w, bh = max(faces, key=lambda f: f[2] * f[3])
                centers.append(((x + w / 2) / w_img, (y + bh / 2) / h_img))
                continue

            # Upper-body fallback
            bodies = body_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=3, minSize=(50, 50)
            )
            if len(bodies):
                x, y, w, bh = max(bodies, key=lambda f: f[2] * f[3])
                centers.append(((x + w / 2) / w_img, (y + bh / 2) / h_img))

        except Exception:
            pass
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    if not centers:
        _face_center_cache[video_path] = default
        return default

    cx = sum(c[0] for c in centers) / len(centers)
    cy = sum(c[1] for c in centers) / len(centers)
    result = (cx, cy)
    _face_center_cache[video_path] = result
    return result


def _smart_crop_filter(video_path: str, target_w: int, target_h: int, zoom: float = 1.0) -> str:
    """
    Return an FFmpeg filter fragment (no input/output labels) that scales the
    video to fill target_w×target_h and crops it centred on the detected face.

    zoom > 1.0 scales to a larger canvas first so the final crop captures a
    smaller region of the original — effectively zooming in on the face.
    zoom=2.0 means only 50% of the source area is visible after cropping.

    Example output:
        scale=2276:1280,crop=1080:640:598:320
    """
    info = get_video_info(video_path)
    orig_w, orig_h = info["width"], info["height"]

    # Scale so the smaller dimension fills zoom × tile (larger canvas = tighter crop)
    scale = max(target_w * zoom / orig_w, target_h * zoom / orig_h)
    scaled_w = int(orig_w * scale)
    scaled_h = int(orig_h * scale)

    cx_ratio, cy_ratio = _detect_face_center_ratio(video_path)

    # Map face centre to scaled-space pixel coords
    cx_px = cx_ratio * scaled_w
    cy_px = cy_ratio * scaled_h

    # Top-left of crop window, clamped so the window stays inside the frame
    crop_x = int(max(0, min(scaled_w - target_w, cx_px - target_w / 2)))
    crop_y = int(max(0, min(scaled_h - target_h, cy_px - target_h / 2)))

    return f"scale={scaled_w}:{scaled_h},crop={target_w}:{target_h}:{crop_x}:{crop_y}"


# ---------------------------------------------------------------------------
# Core render dispatch
# ---------------------------------------------------------------------------

def render_project(project: dict, targets: list[str], projects_dir: Path,
                   camera_layout: str = "edl", cam_order: list = None) -> dict:
    """Render a project to the requested targets. Returns {target: result_dict}."""
    project_dir = Path(projects_dir) / project["id"]
    output_dir = project_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    edl = project["edl"]

    # Build speakers dict, respecting user-specified camera order for split layouts
    all_speakers = {s["id"]: s for s in project["speakers"]}
    if camera_layout == "split" and cam_order:
        speakers_dict = {cid: all_speakers[cid] for cid in cam_order if cid in all_speakers}
    else:
        speakers_dict = all_speakers

    results = {}

    for target in targets:
        try:
            if target == "fullEdit":
                out = str(output_dir / "fullEdit.mp4")
                if camera_layout == "split":
                    input_args, filter_complex = _build_splitscreen_filter_landscape(
                        speakers_dict, edl["segments"]
                    )
                    cmd = ["ffmpeg", "-y"] + input_args + [
                        "-filter_complex", filter_complex,
                        "-map", "[outv]", "-map", "[outa]",
                        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
                        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                        out,
                    ]
                    _run_ffmpeg(cmd)
                else:
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

        file_path = speakers_dict[cam]["file_path"]
        if vertical:
            crop_frag = _smart_crop_filter(file_path, 1080, 1920)
            vf = (
                f"[{idx}:v]trim=start={s}:end={e},setpts=PTS-STARTPTS,"
                f"{crop_frag}[v{i}]"
            )
        else:
            crop_frag = _smart_crop_filter(file_path, 1920, 1080)
            vf = (
                f"[{idx}:v]trim=start={s}:end={e},setpts=PTS-STARTPTS,"
                f"{crop_frag}[v{i}]"
            )

        af = f"[{idx}:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]"
        filter_parts.extend([vf, af])
        stream_labels.extend([f"[v{i}]", f"[a{i}]"])

    n = len(kept_segments)
    concat_str = "".join(stream_labels) + f"concat=n={n}:v=1:a=1[outv][outa]"
    filter_complex = ";".join(filter_parts) + ";" + concat_str

    return input_args, filter_complex, n


def _build_splitscreen_filter_landscape(speakers_dict: dict, segments: list[dict]):
    """
    Build a 16:9 split-screen filter showing all cameras side-by-side for the
    full duration of all kept segments (EDL cuts still applied to timing, but all
    cams visible simultaneously).

    Layout for 1920×1080:
      2 cams → side by side, each 960×1080
      3 cams → three columns,  each 640×1080
      4 cams → 2×2 grid,       each 960×540
    """
    cam_ids = list(speakers_dict.keys())
    n_cams = len(cam_ids)
    if n_cams == 0:
        raise ValueError("No cameras in project")

    kept = [s for s in segments if s.get("keep", True)]
    if not kept:
        raise ValueError("No kept segments to render")

    input_args = []
    for cam_id in cam_ids:
        input_args.extend(["-i", speakers_dict[cam_id]["file_path"]])

    # Tile dimensions (total canvas 1920×1080)
    if n_cams == 1:
        per_w, per_h = 1920, 1080
    elif n_cams == 2:
        per_w, per_h = 960, 1080
    elif n_cams == 3:
        per_w, per_h = 640, 1080
    else:  # 4
        per_w, per_h = 960, 540

    filter_parts = []
    concat_v_labels = []
    concat_a_labels = []

    # Pre-compute smart crop per camera (runs face detection once per cam)
    tile_zoom = {1: 1.0, 2: 2.0, 3: 2.0, 4: 1.5}.get(n_cams, 1.5)
    cam_crop = {
        cam_id: _smart_crop_filter(speakers_dict[cam_id]["file_path"], per_w, per_h, zoom=tile_zoom)
        for cam_id in cam_ids
    }

    for si, seg in enumerate(kept):
        cs, ce = seg["start"], seg["end"]

        for ki, cam_id in enumerate(cam_ids):
            filter_parts.append(
                f"[{ki}:v]trim=start={cs}:end={ce},setpts=PTS-STARTPTS,"
                f"{cam_crop[cam_id]}[sv{si}_{ki}]"
            )

        tile_labels = "".join(f"[sv{si}_{ki}]" for ki in range(n_cams))
        if n_cams == 1:
            filter_parts.append(f"[sv{si}_0]copy[sv{si}]")
        elif n_cams == 2:
            filter_parts.append(f"{tile_labels}hstack=inputs=2[sv{si}]")
        elif n_cams == 3:
            filter_parts.append(f"{tile_labels}hstack=inputs=3[sv{si}]")
        else:
            filter_parts.append(
                f"{tile_labels}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[sv{si}]"
            )

        # Mix audio from all cams
        for ki in range(n_cams):
            filter_parts.append(
                f"[{ki}:a]atrim=start={cs}:end={ce},asetpts=PTS-STARTPTS[sa{si}_{ki}]"
            )
        amix_in = "".join(f"[sa{si}_{ki}]" for ki in range(n_cams))
        filter_parts.append(f"{amix_in}amix=inputs={n_cams}:normalize=0[sa{si}]")

        concat_v_labels.append(f"[sv{si}]")
        concat_a_labels.append(f"[sa{si}]")

    n = len(kept)
    all_labels = "".join(concat_v_labels[i] + concat_a_labels[i] for i in range(n))
    filter_parts.append(f"{all_labels}concat=n={n}:v=1:a=1[outv][outa]")

    return input_args, ";".join(filter_parts)


def _build_splitscreen_filter(clips: list[dict], speakers_dict: dict):
    """
    Build an FFmpeg filter that shows ALL cameras simultaneously, stacked/tiled
    for each clip window, then concatenates the clips.

    Layout for 9:16 (1080×1920):
      1 cam  → 1080×1920 full
      2 cams → stacked vertically, each 1080×960
      3 cams → stacked vertically, each 1080×640
      4 cams → 2×2 grid, each 540×960
    """
    cam_ids = list(speakers_dict.keys())
    n_cams = len(cam_ids)
    if n_cams == 0:
        raise ValueError("No cameras in project")

    # Input args: one per camera
    input_args = []
    for cam_id in cam_ids:
        input_args.extend(["-i", speakers_dict[cam_id]["file_path"]])

    # Per-cam tile dimensions
    if n_cams == 1:
        per_w, per_h = 1080, 1920
    elif n_cams == 2:
        per_w, per_h = 1080, 960
    elif n_cams == 3:
        per_w, per_h = 1080, 640
    else:  # 4+
        per_w, per_h = 540, 960

    filter_parts = []
    concat_v_labels = []
    concat_a_labels = []

    # Pre-compute smart crop per camera once
    tile_zoom = {1: 1.0, 2: 1.5, 3: 2.0, 4: 1.5}.get(n_cams, 1.5)
    cam_crop = {
        cam_id: _smart_crop_filter(speakers_dict[cam_id]["file_path"], per_w, per_h, zoom=tile_zoom)
        for cam_id in cam_ids
    }

    for ci, clip in enumerate(clips):
        cs, ce = clip["start"], clip["end"]

        # Scale + smart-crop each cam tile
        for ki, cam_id in enumerate(cam_ids):
            filter_parts.append(
                f"[{ki}:v]trim=start={cs}:end={ce},setpts=PTS-STARTPTS,"
                f"{cam_crop[cam_id]}[cv{ci}_{ki}]"
            )

        # Stack tiles
        tile_labels = "".join(f"[cv{ci}_{ki}]" for ki in range(n_cams))
        if n_cams == 1:
            filter_parts.append(f"[cv{ci}_0]copy[cv{ci}]")
        elif n_cams <= 3:
            filter_parts.append(f"{tile_labels}vstack=inputs={n_cams}[cv{ci}]")
        else:
            # 2×2 xstack
            filter_parts.append(
                f"{tile_labels}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[cv{ci}]"
            )

        # Trim + mix audio from all cameras
        for ki in range(n_cams):
            filter_parts.append(
                f"[{ki}:a]atrim=start={cs}:end={ce},asetpts=PTS-STARTPTS[ca{ci}_{ki}]"
            )
        amix_in = "".join(f"[ca{ci}_{ki}]" for ki in range(n_cams))
        filter_parts.append(f"{amix_in}amix=inputs={n_cams}:normalize=0[ca{ci}]")

        concat_v_labels.append(f"[cv{ci}]")
        concat_a_labels.append(f"[ca{ci}]")

    # Concat all clips
    n_clips = len(clips)
    all_labels = "".join(concat_v_labels[i] + concat_a_labels[i] for i in range(n_clips))
    filter_parts.append(f"{all_labels}concat=n={n_clips}:v=1:a=1[outv][outa]")

    return input_args, ";".join(filter_parts)


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
# Subtitle generation (ASS format, Submagic/Instagram-style)
# ---------------------------------------------------------------------------

def _ass_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{int(s):02d}.{int((s % 1) * 100):02d}"


def _esc_ass(text: str) -> str:
    return text.replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def _hex_to_ass(hex_color: str, alpha: int = 0) -> str:
    """Convert #RRGGBB to ASS &HAABBGGRR& color string."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}&"


def _ass_header(accent: str = "#FFFF00") -> str:
    """
    Build the ASS [Script Info] + [V4+ Styles] header dynamically so the accent
    colour is baked into the named styles used by each render mode.

    Styles defined
    ──────────────
    plain   – white text, thick black outline (classic)
    box     – white text on solid accent-coloured background box
    neon    – accent-coloured text, thick black outline, bold
    active  – for karaoke: accent box behind the active word
    inactive– for karaoke: dimmed white text for non-active words
    """
    ac      = _hex_to_ass(accent, alpha=0)     # opaque accent
    ac_box  = _hex_to_ass(accent, alpha=0x20)  # slightly transparent box fill
    ac_dim  = _hex_to_ass(accent, alpha=0x99)  # dim accent for inactive words

    # Format: Name, Font, Size, Primary, Secondary, Outline, Back, Bold, Italic,
    #         Underline, Strike, ScaleX, ScaleY, Spacing, Angle,
    #         BorderStyle, Outline, Shadow, Align, MarginL, MarginR, MarginV, Encoding
    styles = [
        # plain: white, black outline, BorderStyle=1
        f"Style: plain,Arial,82,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,"
        f"-1,0,0,0,100,100,2,0,1,5,2,2,60,60,180,1",

        # box: white text on accent-coloured opaque box, BorderStyle=3
        f"Style: box,Arial,82,&H00FFFFFF,&H000000FF,{ac},{ac_box},"
        f"-1,0,0,0,100,100,2,0,3,10,0,2,60,60,180,1",

        # neon: accent text, bold, thick black outline
        f"Style: neon,Arial,88,{ac},&H000000FF,&H00000000,&HA0000000,"
        f"-1,0,0,0,100,100,2,0,1,7,3,2,60,60,180,1",

        # active word in karaoke: black text on accent box
        f"Style: active,Arial,82,&H00000000,&H000000FF,{ac},{ac},"
        f"-1,0,0,0,100,100,2,0,3,10,0,2,60,60,180,1",

        # inactive words in karaoke: dimmed white, thin outline
        f"Style: inactive,Arial,82,&H80FFFFFF,&H000000FF,&H40000000,&HA0000000,"
        f"0,0,0,0,100,100,2,0,1,2,1,2,60,60,180,1",
    ]

    return (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 0\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        + "\n".join(styles)
        + "\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def _clamp_chunks(all_words: list[dict], chunk_size: int = 4):
    """Split words into chunks and clamp each chunk's end to the next chunk's start."""
    chunks = [all_words[i:i + chunk_size] for i in range(0, len(all_words), chunk_size)]
    clamped = []
    for ci, chunk in enumerate(chunks):
        t_start = chunk[0]["start"]
        t_end = (
            min(chunk[-1]["end"], chunks[ci + 1][0]["start"] - 0.001)
            if ci + 1 < len(chunks)
            else chunk[-1]["end"]
        )
        if t_end <= t_start:
            t_end = t_start + 0.1
        clamped.append((chunk, t_start, t_end))
    return clamped


def _sub_position_tag(position: str, speakers_dict: dict | None = None) -> str:
    """
    Return an ASS override tag string that positions the subtitle line.

    position values
    ───────────────
    bottom  – \an2  near the bottom edge (default)
    top     – \an8  near the top edge
    auto    – uses face detection on the first camera: if the face sits in the
              bottom half of the frame, subs go to the top, and vice-versa.
              Falls back to bottom if detection fails.
    """
    if position == "top":
        return r"{\an8\pos(540,200)}"

    if position == "middle":
        return r"{\an5\pos(540,960)}"

    if position == "auto" and speakers_dict:
        # Sample the first camera in the dict
        first_cam = next(iter(speakers_dict.values()), None)
        if first_cam:
            _, cy = _detect_face_center_ratio(first_cam["file_path"])
            # Face in bottom 55% → put subs at top
            return r"{\an8\pos(540,200)}" if cy > 0.45 else r"{\an2\pos(540,1730)}"

    # default: bottom
    return r"{\an2\pos(540,1730)}"


def generate_ass(
    merged_transcript: list[dict],
    clips: list[dict],
    edl_segments: list[dict],
    style: str = "chunk",
    accent_color: str = "#FFFF00",
    sub_position: str = "bottom",
    speakers_dict: dict | None = None,
) -> str:
    """
    Generate ASS subtitle content for a short.

    Styles
    ──────
    word        – one word at a time, plain white
    chunk       – 4 words at a time, plain white
    box         – 4 words on a coloured background box
    box_word    – one word at a time on a coloured background box
    karaoke     – 4-word group; active word highlighted in accent box
    neon        – 4-word chunk in bold accent colour
    none        – no subtitles
    """
    if style == "none":
        return ""

    # ── Collect rendered source pieces (EDL cuts applied) ────────────────────
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

    # ── Build word list with output-timeline timestamps ───────────────────────
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

    # ── Fix timestamp overlaps ────────────────────────────────────────────────
    all_words.sort(key=lambda w: w["start"])
    for i in range(len(all_words) - 1):
        if all_words[i]["end"] > all_words[i + 1]["start"]:
            all_words[i]["end"] = all_words[i + 1]["start"] - 0.001
        if all_words[i]["end"] - all_words[i]["start"] < 0.05:
            all_words[i]["end"] = all_words[i]["start"] + 0.05

    # ── Build ASS events ──────────────────────────────────────────────────────
    events = []
    pos = _sub_position_tag(sub_position, speakers_dict)

    ac_ass = _hex_to_ass(accent_color, alpha=0)  # inline colour override

    if style == "word":
        for w in all_words:
            if w["end"] > w["start"]:
                events.append(
                    f"Dialogue: 0,{_ass_time(w['start'])},{_ass_time(w['end'])},"
                    f"plain,,0,0,0,,{pos}{_esc_ass(w['word'].upper())}"
                )

    elif style == "chunk":
        for chunk, t_start, t_end in _clamp_chunks(all_words):
            text = " ".join(w["word"].upper() for w in chunk)
            events.append(
                f"Dialogue: 0,{_ass_time(t_start)},{_ass_time(t_end)},"
                f"plain,,0,0,0,,{pos}{_esc_ass(text)}"
            )

    elif style == "box":
        for chunk, t_start, t_end in _clamp_chunks(all_words):
            text = " ".join(w["word"].upper() for w in chunk)
            events.append(
                f"Dialogue: 0,{_ass_time(t_start)},{_ass_time(t_end)},"
                f"box,,0,0,0,,{pos}{_esc_ass(text)}"
            )

    elif style == "box_word":
        for w in all_words:
            if w["end"] > w["start"]:
                events.append(
                    f"Dialogue: 0,{_ass_time(w['start'])},{_ass_time(w['end'])},"
                    f"box,,0,0,0,,{pos}{_esc_ass(w['word'].upper())}"
                )

    elif style == "karaoke":
        for chunk, _, group_end in _clamp_chunks(all_words):
            for j, active_w in enumerate(chunk):
                w_start = active_w["start"]
                w_end = chunk[j + 1]["start"] if j + 1 < len(chunk) else group_end
                if w_end <= w_start:
                    w_end = w_start + 0.05

                parts = []
                for k, w in enumerate(chunk):
                    word_up = _esc_ass(w["word"].upper())
                    if k == j:
                        # Active word: accent box style via inline override
                        parts.append(f"{{\\r active}}{word_up}{{\\r inactive}}")
                    else:
                        parts.append(word_up)
                # Emit inactive base + one active overlay
                inactive_line = "  ".join(
                    _esc_ass(w["word"].upper()) for w in chunk
                )
                events.append(
                    f"Dialogue: 0,{_ass_time(w_start)},{_ass_time(w_end)},"
                    f"inactive,,0,0,0,,{pos}{_esc_ass(inactive_line)}"
                )
                active_word = _esc_ass(active_w["word"].upper())
                events.append(
                    f"Dialogue: 1,{_ass_time(w_start)},{_ass_time(w_end)},"
                    f"active,,0,0,0,,{pos}{active_word}"
                )

    elif style == "neon":
        for chunk, t_start, t_end in _clamp_chunks(all_words):
            text = " ".join(w["word"].upper() for w in chunk)
            events.append(
                f"Dialogue: 0,{_ass_time(t_start)},{_ass_time(t_end)},"
                f"neon,,0,0,0,,{pos}{_esc_ass(text)}"
            )

    return _ass_header(accent_color) + "\n".join(events) + "\n"


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
    camera_layout: str = "active",
    accent_color: str = "#FFFF00",
    sub_position: str = "auto",
) -> None:
    """
    Render a short from one or more user-defined clip windows.

    clips          — [{start, end, label?}, ...]  (original-timeline timestamps)
    edl_segments   — full EDL segment list (kept + cut)
    subtitle_style — 'word'|'chunk'|'box'|'box_word'|'karaoke'|'neon'|'none'
    camera_layout  — 'active' (EDL-driven single cam) | 'all' (split-screen all cams)
    accent_color   — hex colour string e.g. '#FFFF00'
    """
    if camera_layout == "all":
        # Show all cameras simultaneously stacked/tiled — use full clip windows, no EDL cuts
        if not clips:
            raise ValueError("No clips provided for split-screen render.")
        input_args, filter_complex = _build_splitscreen_filter(clips, speakers_dict)
    else:
        # Resolve kept sub-segments within each clip window (EDL-aware, single cam)
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
        ass_content = generate_ass(
            merged_transcript, clips, edl_segments,
            subtitle_style, accent_color,
            sub_position=sub_position,
            speakers_dict=speakers_dict,
        )
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

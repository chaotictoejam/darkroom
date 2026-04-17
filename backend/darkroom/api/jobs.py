"""
Job endpoints — transcription, AI analysis, rendering.
WebSocket /api/ws/{project_id} streams progress to the frontend.
"""
import asyncio
import os
import re
import shutil
import threading
import traceback
from collections import defaultdict
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..services.editor import build_prompt, generate_edl, generate_skip_edl, validate_edl
from ..services.renderer import (
    _detect_face_center_ratio,
    check_ffmpeg,
    render_preview,
    render_project,
    render_short_custom,
)
from ..services.transcription import merge_transcripts, transcribe_all
from ..storage import PROJECTS_DIR, get_project, save_project

router = APIRouter()

# ── WebSocket progress hub ────────────────────────────────────────────────────
# Background threads call _push() to notify all connected WebSocket clients
# watching a given project_id.

_loop: asyncio.AbstractEventLoop | None = None
_queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
_queues_lock = threading.Lock()


def _set_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def _push(project_id: str, data: dict) -> None:
    """Thread-safe: enqueue a progress event for all WS subscribers."""
    if _loop is None:
        return
    with _queues_lock:
        qs = list(_queues[project_id])
    for q in qs:
        asyncio.run_coroutine_threadsafe(q.put(data), _loop)


@router.websocket("/ws/{project_id}")
async def ws_progress(websocket: WebSocket, project_id: str) -> None:
    await websocket.accept()
    q: asyncio.Queue = asyncio.Queue()
    with _queues_lock:
        _queues[project_id].append(q)
    try:
        while True:
            try:
                data = await asyncio.wait_for(q.get(), timeout=20.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
                continue
            await websocket.send_json(data)
            # Close cleanly once the job reaches a terminal state.
            # Preview events (type=preview_*) keep the socket open.
            if data.get("type", "").startswith("preview_"):
                continue
            if data.get("status") in ("ready", "error", "transcribed"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        with _queues_lock:
            try:
                _queues[project_id].remove(q)
            except ValueError:
                pass


def _update_progress(project_id: str, **kwargs) -> None:
    """Persist progress to disk AND push to WS subscribers."""
    proj = get_project(project_id)
    if not proj:
        return
    proj.update(kwargs)
    save_project(proj)
    _push(project_id, {"status": proj["status"], "progress": proj["progress"]})


# ── System status ─────────────────────────────────────────────────────────────

@router.get("/status")
def api_status():
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    return {
        "ffmpeg_available": check_ffmpeg(),
        "anthropic_configured": bool(api_key and api_key not in ("", "your_anthropic_api_key_here")),
    }


# ── Render locks (one FFmpeg process per project) ─────────────────────────────

_render_locks: dict[str, threading.Lock] = {}
_render_locks_mutex = threading.Lock()


def _get_render_lock(project_id: str) -> threading.Lock:
    with _render_locks_mutex:
        if project_id not in _render_locks:
            _render_locks[project_id] = threading.Lock()
        return _render_locks[project_id]


# ── Transcription ─────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/transcribe")
def start_transcription(project_id: str):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    def _run():
        try:
            _update_progress(
                project_id,
                status="transcribing",
                transcripts={},
                merged_transcript=[],
                edl=None,
                progress={"step": "transcribing", "percent": 5, "message": "Loading Whisper model…"},
            )
            p = get_project(project_id)
            model_name = p.get("transcribe_model") or "medium"
            language = p.get("transcribe_language") or None
            total = len(p["speakers"])

            def _progress(i, _total, name):
                pct = int(10 + (i / _total) * 55)
                _update_progress(
                    project_id,
                    progress={"step": "transcribing", "percent": pct, "message": f"Transcribing {name} ({i + 1}/{_total})…"},
                )

            transcripts = transcribe_all(p["speakers"], model_name, _progress, language=language)

            _update_progress(
                project_id,
                transcripts=transcripts,
                progress={"step": "merging", "percent": 70, "message": "Merging transcripts…"},
            )
            p = get_project(project_id)
            merged = merge_transcripts(transcripts, p["speakers"])
            _update_progress(
                project_id,
                merged_transcript=merged,
                status="transcribed",
                progress={"step": "done", "percent": 100, "message": "Transcription complete ✓"},
            )

        except Exception:
            _update_progress(
                project_id,
                status="error",
                progress={"step": "error", "percent": 0, "message": traceback.format_exc()},
            )

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Transcription started"}


# ── AI analysis ───────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/analyze")
def analyze_project(project_id: str):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    def _run():
        try:
            _update_progress(
                project_id,
                status="analyzing",
                progress={"step": "analyzing", "percent": 10, "message": "Sending transcript to Claude…"},
            )
            p = get_project(project_id)
            edl = generate_edl(p["merged_transcript"], p["speakers"])
            _update_progress(
                project_id,
                edl=edl,
                status="ready",
                progress={"step": "done", "percent": 100, "message": "Analysis complete ✓"},
            )
        except Exception:
            _update_progress(
                project_id,
                status="error",
                progress={"step": "error", "percent": 0, "message": traceback.format_exc()},
            )

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Analysis started"}


# ── Analysis alternatives ─────────────────────────────────────────────────────

@router.get("/projects/{project_id}/prompt")
def get_prompt(project_id: str):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if not proj.get("merged_transcript"):
        raise HTTPException(400, "No transcript yet")
    return {"prompt": build_prompt(proj["merged_transcript"], proj["speakers"])}


@router.post("/projects/{project_id}/skip-analysis")
def skip_analysis(project_id: str):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    edl = generate_skip_edl(proj["merged_transcript"], proj["speakers"])
    proj["edl"] = edl
    proj["status"] = "ready"
    proj["progress"] = {"step": "done", "percent": 100, "message": "Skipped analysis — all segments kept"}
    save_project(proj)
    return proj


class ImportEdlBody(BaseModel):
    edl: dict


@router.post("/projects/{project_id}/import-edl")
def import_edl(project_id: str, body: ImportEdlBody):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    mt = proj.get("merged_transcript") or []
    total_duration = mt[-1]["end"] if mt else None
    try:
        validate_edl(body.edl, total_duration=total_duration)
    except ValueError as exc:
        raise HTTPException(400, f"Invalid EDL: {exc}")
    proj["edl"] = body.edl
    proj["status"] = "ready"
    proj["progress"] = {"step": "done", "percent": 100, "message": "EDL imported ✓"}
    save_project(proj)
    return proj


@router.put("/projects/{project_id}/edl")
def update_edl(project_id: str, edl: dict):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    proj["edl"] = edl
    save_project(proj)
    return proj


# ── Rendering ─────────────────────────────────────────────────────────────────

class RenderBody(BaseModel):
    targets: list[str] = ["fullEdit"]
    camera_layout: str = "edl"
    cam_order: Optional[list[str]] = None


@router.post("/projects/{project_id}/render")
def start_render(project_id: str, body: RenderBody):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if not check_ffmpeg():
        raise HTTPException(503, "FFmpeg not found on this system")

    lock = _get_render_lock(project_id)
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "A render is already in progress for this project")

    def _run():
        try:
            _update_progress(
                project_id,
                status="rendering",
                progress={"step": "rendering", "percent": 5, "message": f"Rendering {', '.join(body.targets)}…"},
            )
            p = get_project(project_id)
            results = render_project(p, body.targets, PROJECTS_DIR,
                                     camera_layout=body.camera_layout,
                                     cam_order=body.cam_order)
            p = get_project(project_id)
            p["renders"].update(results)
            errors = [t for t, r in results.items() if r.get("status") == "error"]
            msg = f"Render finished with errors: {', '.join(errors)}" if errors else "Render complete ✓"
            _update_progress(
                project_id,
                renders=p["renders"],
                status="ready",
                progress={"step": "error" if errors else "done", "percent": 100, "message": msg},
            )
        except Exception:
            _update_progress(
                project_id,
                status="error",
                progress={"step": "error", "percent": 0, "message": traceback.format_exc()},
            )
        finally:
            lock.release()

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Render started"}


class RenderShortBody(BaseModel):
    clips: list[dict]
    subtitle_style: str = "chunk"
    camera_layout: str = "active"
    selected_cams: Optional[list[str]] = None
    accent_color: str = "#FFFF00"
    sub_position: str = "auto"
    output_name: str = "short_01"
    box_opacity: int = 100


@router.post("/projects/{project_id}/render-short")
def start_render_short(project_id: str, body: RenderShortBody):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if not check_ffmpeg():
        raise HTTPException(503, "FFmpeg not found — install it and restart Darkroom")
    if not proj.get("edl"):
        raise HTTPException(400, "No EDL — run analysis first")
    if not body.clips:
        raise HTTPException(400, "No clips provided")

    output_name = re.sub(r"[^a-z0-9_\-]", "_", body.output_name.lower()) or "short_01"
    box_alpha = round((100 - max(0, min(100, body.box_opacity))) / 100 * 255)

    lock = _get_render_lock(project_id)
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "A render is already in progress for this project")

    def _run():
        try:
            _update_progress(
                project_id,
                status="rendering",
                progress={"step": "rendering", "percent": 5,
                          "message": f"Rendering short '{output_name}'…"},
            )
            p = get_project(project_id)
            project_dir = PROJECTS_DIR / project_id
            output_dir = project_dir / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            out_path = str(output_dir / f"{output_name}.mp4")
            speakers_dict = {s["id"]: s for s in p["speakers"]}

            if body.camera_layout == "all" and body.selected_cams:
                speakers_dict = {
                    cam_id: speakers_dict[cam_id]
                    for cam_id in body.selected_cams
                    if cam_id in speakers_dict
                }

            render_short_custom(
                clips=body.clips,
                edl_segments=p["edl"]["segments"],
                speakers_dict=speakers_dict,
                subtitle_style=body.subtitle_style,
                camera_layout=body.camera_layout,
                accent_color=body.accent_color,
                sub_position=body.sub_position,
                merged_transcript=p["merged_transcript"],
                output_path=out_path,
                output_dir=output_dir,
                box_alpha=box_alpha,
            )
            p = get_project(project_id)
            p["renders"][output_name] = {
                "status": "done",
                "url": f"/projects/{project_id}/files/output/{output_name}.mp4",
                "filename": f"{output_name}.mp4",
            }
            _update_progress(
                project_id,
                renders=p["renders"],
                status="ready",
                progress={"step": "done", "percent": 100, "message": f"Short '{output_name}' rendered ✓"},
            )
        except Exception:
            _update_progress(
                project_id,
                status="error",
                progress={"step": "error", "percent": 0, "message": traceback.format_exc()},
            )
        finally:
            lock.release()

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Short render started"}


# ── Preview proxy render ──────────────────────────────────────────────────────

@router.post("/projects/{project_id}/preview")
def start_preview(project_id: str):
    """
    Kick off an async ultrafast proxy render (960p, crf42).
    Does NOT change project status — this is a side operation.
    Pushes {"type": "preview_ready"/"preview_error"} over WebSocket when done.
    """
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if not check_ffmpeg():
        raise HTTPException(503, "FFmpeg not found on this system")
    if proj.get("project_type") == "podcast":
        raise HTTPException(400, "Preview proxy not supported for podcast projects")

    lock = _get_render_lock(project_id)
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "A render is already in progress for this project")

    def _run():
        try:
            _push(project_id, {"type": "preview_generating",
                                "progress": {"step": "preview", "percent": 5,
                                             "message": "Building preview…"}})
            result = render_preview(proj, PROJECTS_DIR)
            _push(project_id, {"type": "preview_ready", "url": result["url"]})
        except Exception as exc:
            _push(project_id, {"type": "preview_error",
                                "message": str(exc)})
        finally:
            lock.release()

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Preview render started"}


# ── Face detection ────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/face-centers")
def get_face_centers(project_id: str):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    return {
        sp["id"]: list(_detect_face_center_ratio(sp["file_path"]))
        for sp in proj.get("speakers", [])
    }

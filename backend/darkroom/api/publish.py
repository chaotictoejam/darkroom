"""
DarkRelay publishing: episode details, cover art, and the bundle export job.

The bundle is written into the project's output folder; publishing it with the
DarkRelay CLI is up to the user, so nothing here leaves the machine.
"""
import threading
import traceback
from typing import Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..services.publish import build_bundle, new_guid, validate_details
from ..services.renderer import check_ffmpeg
from ..storage import PROJECTS_DIR, editing_project, get_project
from .jobs import _get_render_lock, _update_progress

router = APIRouter()

_COVER_TYPES = {"image/jpeg": ".jpg", "image/png": ".png"}
_COVER_MAX_BYTES = 20 * 1024 * 1024


class Chapter(BaseModel):
    start: float = Field(ge=0)  # source time, so it follows later edits
    title: str


class PublishDetails(BaseModel):
    show: str = ""
    title: str = ""
    notes: str = ""
    pub_date: Optional[str] = None  # ISO 8601 with offset; None: when published
    episode_type: Literal["full", "trailer", "bonus"] = "full"
    season: Optional[int] = None
    episode: Optional[int] = None
    explicit: Optional[bool] = None
    keywords: list[str] = []
    chapters: list[Chapter] = []
    include_video: bool = True
    yt_title: str = ""
    yt_description: str = ""


@router.put("/projects/{project_id}/publish")
def save_publish_details(project_id: str, body: PublishDetails):
    """Save the episode details. The GUID, cover and last bundle are kept."""
    try:
        with editing_project(project_id) as proj:
            proj["publish"].update(body.model_dump())
    except LookupError:
        raise HTTPException(404, "Project not found")
    return proj


@router.post("/projects/{project_id}/publish/cover")
async def upload_cover(project_id: str, file: UploadFile = File(...)):
    ext = _COVER_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Cover art must be a JPEG or PNG")
    content = await file.read()
    if len(content) > _COVER_MAX_BYTES:
        raise HTTPException(400, "Cover art is over 20 MB")
    if get_project(project_id) is None:
        raise HTTPException(404, "Project not found")
    for old in ("publish_cover.jpg", "publish_cover.png"):
        (PROJECTS_DIR / project_id / old).unlink(missing_ok=True)
    (PROJECTS_DIR / project_id / f"publish_cover{ext}").write_bytes(content)
    with editing_project(project_id) as proj:
        proj["publish"]["cover"] = f"publish_cover{ext}"
    return proj


@router.delete("/projects/{project_id}/publish/cover")
def delete_cover(project_id: str):
    try:
        with editing_project(project_id) as proj:
            if proj["publish"].get("cover"):
                (PROJECTS_DIR / project_id / proj["publish"]["cover"]).unlink(missing_ok=True)
            proj["publish"]["cover"] = None
    except LookupError:
        raise HTTPException(404, "Project not found")
    return proj


@router.post("/projects/{project_id}/publish/bundle")
def start_bundle(project_id: str):
    """Render the edit and write the DarkRelay bundle in the background."""
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if not proj.get("edl"):
        raise HTTPException(400, "Run AI analysis (or skip it) first: the bundle is made from the edit")
    errors = validate_details(proj["publish"])
    if errors:
        raise HTTPException(400, "\n".join(errors))
    if not check_ffmpeg():
        raise HTTPException(503, "FFmpeg not found on this system")

    lock = _get_render_lock(project_id)
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "A render is already in progress for this project")

    # Set once, before the first bundle, so every re-export updates the same episode
    with editing_project(project_id) as p:
        if not p["publish"].get("guid"):
            p["publish"]["guid"] = new_guid()

    def _step(message: str, percent: int) -> None:
        _update_progress(project_id, status="rendering",
                         progress={"step": "publishing", "percent": percent, "message": message})

    def _run():
        try:
            _step("Preparing DarkRelay bundle…", 5)
            bundle = build_bundle(get_project(project_id), PROJECTS_DIR, _step)
            with editing_project(project_id) as p:
                p["publish"]["bundle"] = bundle
            _update_progress(project_id, status="ready",
                             progress={"step": "done", "percent": 100, "message": "DarkRelay bundle ready ✓"})
        except Exception as exc:
            traceback.print_exc()
            _update_progress(project_id, status="ready",
                             progress={"step": "error", "percent": 0,
                                       "message": f"Bundle failed: {exc}"})
        finally:
            lock.release()

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Bundle started"}

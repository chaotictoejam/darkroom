"""
Project CRUD routes.
"""
import shutil
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..storage import PROJECTS_DIR, editing_project, get_project, list_projects, new_project, save_project

router = APIRouter()


class CreateProjectBody(BaseModel):
    name: str = "Untitled Project"
    project_type: Literal["video", "podcast"] = "video"
    source: Literal["upload", "record"] = "upload"


class PatchProjectBody(BaseModel):
    name: Optional[str] = None
    transcribe_model: Optional[str] = None
    # Present-but-null means auto-detect, so use a sentinel for "not sent".
    transcribe_language: Optional[str] = ""


@router.get("/projects")
def get_projects():
    return [
        {"id": p["id"], "name": p["name"], "status": p["status"], "created_at": p["created_at"],
         "source": p["source"], "project_type": p["project_type"]}
        for p in list_projects()
    ]


@router.post("/projects", status_code=201)
def create_project(body: CreateProjectBody):
    project = new_project(body.name.strip() or "Untitled Project", source=body.source)
    project["project_type"] = body.project_type
    save_project(project)
    return project


@router.get("/projects/{project_id}")
def get_project_route(project_id: str):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    return proj


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, body: PatchProjectBody):
    try:
        with editing_project(project_id) as proj:
            if body.name is not None and body.name.strip():
                proj["name"] = body.name.strip()
            if body.transcribe_model is not None:
                proj["transcribe_model"] = body.transcribe_model
            if body.transcribe_language != "":
                proj["transcribe_language"] = body.transcribe_language or None
    except LookupError:
        raise HTTPException(404, "Project not found")
    return proj


@router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    path = PROJECTS_DIR / project_id
    if path.exists():
        shutil.rmtree(str(path))
    return {"ok": True}


@router.post("/projects/{project_id}/reset-edl")
def reset_edl(project_id: str):
    """Clear EDL and renders, returning project to transcribed state."""
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if not proj.get("merged_transcript"):
        raise HTTPException(400, "No transcript — transcribe first")

    output_dir = PROJECTS_DIR / project_id / "output"
    if output_dir.exists():
        shutil.rmtree(str(output_dir))

    proj["edl"] = None
    proj["renders"] = {}
    proj["status"] = "transcribed"
    proj["progress"] = {"step": "done", "percent": 100, "message": "Transcription complete ✓"}
    save_project(proj)
    return proj


@router.post("/projects/{project_id}/reset")
def reset_project(project_id: str):
    """Reset to uploaded state — keeps video files, clears everything else."""
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    output_dir = PROJECTS_DIR / project_id / "output"
    if output_dir.exists():
        shutil.rmtree(str(output_dir))

    proj["status"] = "uploaded"
    proj["transcripts"] = {}
    proj["merged_transcript"] = []
    proj["edl"] = None
    proj["renders"] = {}
    proj["progress"] = {"step": "uploaded", "percent": 0, "message": "Ready to transcribe"}
    save_project(proj)
    return proj

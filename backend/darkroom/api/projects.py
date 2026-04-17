"""
Project CRUD routes.
"""
import shutil
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..storage import PROJECTS_DIR, get_project, list_projects, new_project, save_project

router = APIRouter()


class CreateProjectBody(BaseModel):
    name: str = "Untitled Project"
    project_type: str = "video"


@router.get("/projects")
def get_projects():
    return [
        {"id": p["id"], "name": p["name"], "status": p["status"], "created_at": p["created_at"]}
        for p in list_projects()
    ]


@router.post("/projects", status_code=201)
def create_project(body: CreateProjectBody):
    project = new_project(body.name)
    project["project_type"] = body.project_type
    save_project(project)
    return project


@router.get("/projects/{project_id}")
def get_project_route(project_id: str):
    proj = get_project(project_id)
    if not proj:
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

"""
Project persistence — thin filesystem wrapper.

All project data lives under PROJECTS_DIR/<project_id>/project.json.
Writes are atomic (write-to-tmp, then rename) to prevent corruption on crash.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Allow override via env var so tests can redirect to a temp directory.
PROJECTS_DIR = Path(os.getenv("DARKROOM_PROJECTS_DIR", str(Path(__file__).parent.parent.parent / "projects")))


def project_path(project_id: str) -> Path:
    return PROJECTS_DIR / project_id / "project.json"


_DEFAULTS = {
    "word_cuts": [],
    "renders": {},
    "progress": {"step": "", "percent": 0, "message": ""},
}


def get_project(project_id: str) -> dict | None:
    path = project_path(project_id)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        proj = json.load(f)
    # Backfill fields added after initial release so old projects load cleanly
    changed = False
    for key, default in _DEFAULTS.items():
        if key not in proj:
            proj[key] = default
            changed = True
    if changed:
        save_project(proj)
    return proj


def save_project(project: dict) -> None:
    path = project_path(project["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(project, f, indent=2)
    tmp.replace(path)  # atomic on POSIX; near-atomic on Windows


def list_projects() -> list[dict]:
    if not PROJECTS_DIR.exists():
        return []
    projects = []
    for d in sorted(PROJECTS_DIR.iterdir(), reverse=True):
        if d.is_dir():
            proj = get_project(d.name)
            if proj:
                projects.append(proj)
    return projects


def new_project(name: str) -> dict:
    return {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "created",
        "speakers": [],
        "transcripts": {},
        "merged_transcript": [],
        "edl": None,
        "word_cuts": [],
        "renders": {},
        "progress": {"step": "", "percent": 0, "message": ""},
    }

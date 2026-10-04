"""
Project persistence — thin filesystem wrapper.

All project data lives under PROJECTS_DIR/<project_id>/project.json.
Writes are atomic (write-to-tmp, then rename) to prevent corruption on crash.
"""
import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# Allow override via env var so tests can redirect to a temp directory.
PROJECTS_DIR = Path(os.getenv("DARKROOM_PROJECTS_DIR", str(Path(__file__).parent.parent.parent / "projects")))


def project_path(project_id: str) -> Path:
    return PROJECTS_DIR / project_id / "project.json"


_DEFAULTS = {
    "project_type": "video",
    "source": "upload",
    "word_cuts": [],
    "word_mutes": [],
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


_locks: dict[str, threading.RLock] = {}
_locks_mutex = threading.Lock()


def _project_lock(project_id: str) -> threading.RLock:
    with _locks_mutex:
        return _locks.setdefault(project_id, threading.RLock())


@contextmanager
def editing_project(project_id: str) -> Iterator[dict]:
    """
    Load a project, let the caller change it, then save it, all under a
    per-project lock. Background jobs (per-take transcription, finalising,
    progress updates) run at the same time, and a plain load-change-save from
    two threads would drop one of the changes.

    Raises LookupError if the project does not exist.
    """
    with _project_lock(project_id):
        proj = get_project(project_id)
        if proj is None:
            raise LookupError(project_id)
        yield proj
        save_project(proj)


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


def new_project(name: str, source: str = "upload") -> dict:
    return {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "recording" if source == "record" else "created",
        "source": source,
        "speakers": [],
        "transcripts": {},
        "merged_transcript": [],
        "edl": None,
        "project_type": "video",
        "word_cuts": [],
        "word_mutes": [],
        "renders": {},
        "progress": {"step": "", "percent": 0, "message": ""},
    }

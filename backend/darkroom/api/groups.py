"""
Project group routes.

A group is just a label on a project (`project["group"]`, "" when ungrouped),
so there is nothing to create or garbage-collect: a group exists while at least
one project names it. Renaming and ungrouping touch every project in the group.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..storage import editing_project, list_projects

router = APIRouter()


class RenameGroupBody(BaseModel):
    old: str
    new: str


class GroupBody(BaseModel):
    name: str


def _groups() -> list[dict]:
    counts: dict[str, int] = {}
    for proj in list_projects():
        name = (proj.get("group") or "").strip()
        if name:
            counts[name] = counts.get(name, 0) + 1
    return [{"name": name, "count": counts[name]} for name in sorted(counts, key=str.casefold)]


def _ids_in_group(name: str) -> list[str]:
    return [p["id"] for p in list_projects() if (p.get("group") or "").strip().casefold() == name.casefold()]


@router.get("/groups")
def get_groups():
    """Every group in use, alphabetical, with how many projects it holds."""
    return _groups()


@router.post("/groups/rename")
def rename_group(body: RenameGroupBody):
    """Move every project in `old` to `new`; an empty `new` ungroups them."""
    old = body.old.strip()
    if not old:
        raise HTTPException(400, "No group given")
    new = body.new.strip()
    ids = _ids_in_group(old)
    if not ids:
        raise HTTPException(404, "Group not found")
    for project_id in ids:
        with editing_project(project_id) as proj:
            proj["group"] = new
    return {"moved": len(ids), "groups": _groups()}


@router.post("/groups/ungroup")
def ungroup_group(body: GroupBody):
    """Empty a group. Its projects stay, just without a group."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "No group given")
    ids = _ids_in_group(name)
    if not ids:
        raise HTTPException(404, "Group not found")
    for project_id in ids:
        with editing_project(project_id) as proj:
            proj["group"] = ""
    return {"moved": len(ids), "groups": _groups()}

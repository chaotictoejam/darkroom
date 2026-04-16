"""
File upload and transcript editing routes.
"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from typing import Optional

from ..storage import PROJECTS_DIR, get_project, save_project

router = APIRouter()

_CAM_IDS = ["A", "B", "C", "D"]


@router.post("/projects/{project_id}/upload")
async def upload_files(
    project_id: str,
    files: list[UploadFile] = File(...),
    names: list[str] = Form(...),
    language: Optional[str] = Form(default=None),
    model: str = Form(default="medium"),
):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    project_dir = PROJECTS_DIR / project_id
    project_dir.mkdir(exist_ok=True)

    speakers = []
    for i, (f, name) in enumerate(zip(files, names)):
        cam_id = _CAM_IDS[i]
        safe_name = "".join(c for c in (f.filename or "") if c.isalnum() or c in "._- ").strip()
        filename = f"cam_{cam_id}_{safe_name}"
        filepath = project_dir / filename
        content = await f.read()
        filepath.write_bytes(content)
        speakers.append({
            "id": cam_id,
            "name": name.strip() or f"Speaker {cam_id}",
            "file": filename,
            "file_path": str(filepath),
        })

    proj["speakers"] = speakers
    proj["transcribe_language"] = language or None
    proj["transcribe_model"] = model
    proj["status"] = "uploaded"
    proj["progress"] = {"step": "uploaded", "percent": 0, "message": "Files uploaded"}
    save_project(proj)
    return proj


class WordCutItem(BaseModel):
    start: float
    end: float


class WordCutsBody(BaseModel):
    word_cuts: list[WordCutItem]


@router.put("/projects/{project_id}/word-cuts")
def save_word_cuts(project_id: str, body: WordCutsBody):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    proj["word_cuts"] = [{"start": c.start, "end": c.end} for c in body.word_cuts]
    save_project(proj)
    return {"ok": True}


class WordMuteItem(BaseModel):
    start: float
    end: float


class WordMutesBody(BaseModel):
    word_mutes: list[WordMuteItem]


@router.put("/projects/{project_id}/word-mutes")
def save_word_mutes(project_id: str, body: WordMutesBody):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    proj["word_mutes"] = [{"start": m.start, "end": m.end} for m in body.word_mutes]
    save_project(proj)
    return {"ok": True}


class TranscriptPatch(BaseModel):
    text: str


@router.patch("/projects/{project_id}/transcript/{seg_index}")
def update_transcript_segment(project_id: str, seg_index: int, body: TranscriptPatch):
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    mt = proj.get("merged_transcript", [])
    if seg_index < 0 or seg_index >= len(mt):
        raise HTTPException(400, "Segment index out of range")

    seg = mt[seg_index]
    seg["text"] = body.text.strip()

    # Redistribute word-level timestamps evenly across the segment duration
    words = [w for w in seg["text"].split() if w]
    if words:
        duration = seg["end"] - seg["start"]
        step = duration / len(words)
        seg["words"] = [
            {"word": " " + w, "start": seg["start"] + i * step, "end": seg["start"] + (i + 1) * step}
            for i, w in enumerate(words)
        ]
    else:
        seg["words"] = []

    proj["merged_transcript"] = mt
    save_project(proj)
    return {"ok": True, "segment": seg}

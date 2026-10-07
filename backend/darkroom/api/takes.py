"""
Recording studio routes — takes are streamed to disk while recording,
finalised on Stop, transcribed one at a time in the background, and joined
into per-speaker tracks when the user moves on to the editor.
"""
import asyncio
import queue
import shutil
import threading
import traceback
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..services.takes import (
    PARTICIPANT_IDS,
    ChunkOffsetError,
    append_chunk,
    combine_transcripts,
    finalise_take,
    is_take_id,
    join_tracks,
    next_take_id,
    participant_for_source,
    read_take_transcript,
    write_take_transcript,
)
from ..services.transcription import default_model, transcribe_file
from ..storage import PROJECTS_DIR, editing_project, get_project, list_projects
from .jobs import _push

router = APIRouter()


def _find_take(proj: dict, take_id: str) -> dict | None:
    return next((t for t in proj.get("takes", []) if t["id"] == take_id), None)


def _load(project_id: str) -> dict:
    proj = get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    if proj.get("source") != "record":
        raise HTTPException(400, "Not a recorded project")
    return proj


def _push_take(project_id: str, take: dict) -> None:
    _push(project_id, {"type": "take", "take": take})


def _set_take(project_id: str, take_id: str, **fields) -> dict | None:
    """Update one take's fields and notify the studio. None if it was deleted meanwhile."""
    try:
        with editing_project(project_id) as proj:
            take = _find_take(proj, take_id)
            if take is None:
                return None
            for key, value in fields.items():
                if isinstance(value, dict) and isinstance(take.get(key), dict):
                    take[key] = {**take[key], **value}
                else:
                    take[key] = value
    except LookupError:
        return None
    _push_take(project_id, take)
    return take


# ── Transcription worker ──────────────────────────────────────────────────────
# One take at a time: each transcription loads a Whisper model, and running
# several at once would compete for the same CPU/GPU and memory.

_transcribe_queue: "queue.Queue[tuple[str, str]]" = queue.Queue()
_worker_lock = threading.Lock()
_worker: threading.Thread | None = None


def _enqueue_transcription(project_id: str, take_id: str) -> None:
    global _worker
    _set_take(project_id, take_id, transcription={"status": "pending", "percent": 0, "error": None})
    _transcribe_queue.put((project_id, take_id))
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_worker_loop, daemon=True)
            _worker.start()


def _worker_loop() -> None:
    while True:
        project_id, take_id = _transcribe_queue.get()
        try:
            transcribe_take(project_id, take_id)
        finally:
            _transcribe_queue.task_done()


def transcribe_take(project_id: str, take_id: str) -> None:
    """Transcribe every track of one take and store it with the take."""
    proj = get_project(project_id)
    take = _find_take(proj, take_id) if proj else None
    if not take or take["status"] != "ready":
        return

    take_dir = PROJECTS_DIR / project_id / "takes" / take_id
    names = {p["id"]: p["name"] for p in proj.get("participants", [])}
    language = proj.get("transcribe_language") or None
    model_name = proj.get("transcribe_model") or default_model(language)
    tracks = list(take["tracks"].items())

    _set_take(project_id, take_id, transcription={"status": "transcribing", "percent": 0})
    try:
        transcripts = {}
        for i, (pid, filename) in enumerate(tracks):
            def _progress(frac: float, _i: int = i) -> None:
                percent = int((_i + frac) / len(tracks) * 100)
                # Pushed but not saved: a save per tick would rewrite project.json every 1.5 s.
                _push_take(project_id, {**take, "transcription": {"status": "transcribing", "percent": percent}})

            name = names.get(pid) or f"Speaker {pid}"
            transcripts[pid] = transcribe_file(str(take_dir / filename), pid, name, model_name,
                                               language=language, progress_callback=_progress)
        if not take_dir.exists():  # deleted while transcribing
            return
        write_take_transcript(take_dir, transcripts)
        _set_take(project_id, take_id, transcription={"status": "done", "percent": 100, "error": None})
    except Exception:
        _set_take(project_id, take_id,
                  transcription={"status": "error", "percent": 0, "error": traceback.format_exc()[-2000:]})


# ── Crash recovery ────────────────────────────────────────────────────────────

def _finalise_into_project(project_id: str, take_id: str, recovered: bool = False) -> dict | None:
    result = finalise_take(PROJECTS_DIR / project_id / "takes" / take_id)
    if result["tracks"]:
        fields = {"status": "ready", "tracks": result["tracks"], "duration": result["duration"], "error": None}
    else:
        detail = "; ".join(result["errors"].values()) or "No audio was recorded"
        fields = {"status": "error", "tracks": {}, "duration": 0.0, "error": detail}
    if recovered:
        fields["recovered"] = True
    take = _set_take(project_id, take_id, **fields)
    if take and take["status"] == "ready":
        _enqueue_transcription(project_id, take_id)
    return take


def recover_unfinished_takes() -> None:
    """
    On startup: finalise takes that were still recording when the app stopped,
    and restart transcriptions that never finished. Recovered takes are flagged
    so the studio can ask whether to keep them.
    """
    for proj in list_projects():
        for take in proj.get("takes", []):
            try:
                if take["status"] in ("recording", "finalizing"):
                    _finalise_into_project(proj["id"], take["id"], recovered=True)
                elif take["status"] == "ready" and take["transcription"]["status"] in ("pending", "transcribing"):
                    _enqueue_transcription(proj["id"], take["id"])
            except Exception:
                traceback.print_exc()


# ── Routes ────────────────────────────────────────────────────────────────────

class Participant(BaseModel):
    id: str
    name: str = ""


class CreateTakeBody(BaseModel):
    participants: list[Participant]


@router.post("/projects/{project_id}/takes", status_code=201)
def create_take(project_id: str, body: CreateTakeBody):
    _load(project_id)
    ids = [p.id for p in body.participants]
    if not ids or len(ids) > len(PARTICIPANT_IDS) or len(set(ids)) != len(ids) \
            or any(i not in PARTICIPANT_IDS for i in ids):
        raise HTTPException(400, "Between 1 and 4 participants with ids A–D are required")

    with editing_project(project_id) as proj:
        if any(t["status"] == "recording" for t in proj.get("takes", [])):
            raise HTTPException(409, "A take is already recording")

        # Keep names of participants who were in earlier takes but not this one.
        known = {p["id"]: p for p in proj.get("participants", [])}
        for p in body.participants:
            known[p.id] = {"id": p.id, "name": p.name.strip() or f"Speaker {p.id}"}
        proj["participants"] = [known[i] for i in PARTICIPANT_IDS if i in known]

        takes_dir = PROJECTS_DIR / project_id / "takes"
        takes_dir.mkdir(parents=True, exist_ok=True)
        take_id = next_take_id(takes_dir)
        (takes_dir / take_id).mkdir()
        take = {
            "id": take_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "recording",
            "participants": ids,
            "tracks": {},
            "duration": 0.0,
            "error": None,
            "recovered": False,
            "transcription": {"status": "none", "percent": 0, "error": None},
        }
        proj.setdefault("takes", []).append(take)
        proj["status"] = "recording"
    return take


@router.post("/projects/{project_id}/takes/{take_id}/{source}/chunk")
async def append_take_chunk(project_id: str, take_id: str, source: str, request: Request,
                            offset: int = Query(..., ge=0)):
    pid = participant_for_source(source)
    if pid is None or not is_take_id(take_id):
        raise HTTPException(400, "Unknown source")
    proj = _load(project_id)
    take = _find_take(proj, take_id)
    if not take:
        raise HTTPException(404, "Take not found")
    if take["status"] != "recording" or pid not in take["participants"]:
        raise HTTPException(409, "This take is not recording that source")

    data = await request.body()
    path = PROJECTS_DIR / project_id / "takes" / take_id / f"{source}.part"
    try:
        size = await asyncio.to_thread(append_chunk, path, offset, data)
    except ChunkOffsetError as exc:
        return JSONResponse({"detail": str(exc), "size": exc.size}, status_code=409)
    return {"size": size}


@router.post("/projects/{project_id}/takes/{take_id}/stop")
async def stop_take(project_id: str, take_id: str):
    proj = _load(project_id)
    take = _find_take(proj, take_id)
    if not take:
        raise HTTPException(404, "Take not found")
    if take["status"] != "recording":
        return take
    _set_take(project_id, take_id, status="finalizing")
    take = await asyncio.to_thread(_finalise_into_project, project_id, take_id)
    if take is None:
        raise HTTPException(404, "Take was deleted")
    return take


@router.post("/projects/{project_id}/takes/{take_id}/transcribe")
def retry_take_transcription(project_id: str, take_id: str):
    take = _find_take(_load(project_id), take_id)
    if not take or take["status"] != "ready":
        raise HTTPException(404, "No finished take with that id")
    _enqueue_transcription(project_id, take_id)
    return {"ok": True}


@router.post("/projects/{project_id}/takes/{take_id}/keep")
def keep_recovered_take(project_id: str, take_id: str):
    take = _set_take(project_id, take_id, recovered=False)
    if take is None:
        raise HTTPException(404, "Take not found")
    return take


@router.delete("/projects/{project_id}/takes/{take_id}")
def delete_take(project_id: str, take_id: str):
    _load(project_id)
    if not is_take_id(take_id):
        raise HTTPException(400, "Bad take id")
    with editing_project(project_id) as proj:
        proj["takes"] = [t for t in proj.get("takes", []) if t["id"] != take_id]
    shutil.rmtree(PROJECTS_DIR / project_id / "takes" / take_id, ignore_errors=True)
    return {"ok": True}


class TakeOrderBody(BaseModel):
    order: list[str]


@router.put("/projects/{project_id}/takes/order")
def reorder_takes(project_id: str, body: TakeOrderBody):
    _load(project_id)
    with editing_project(project_id) as proj:
        by_id = {t["id"]: t for t in proj.get("takes", [])}
        if sorted(body.order) != sorted(by_id):
            raise HTTPException(400, "The order must list every take exactly once")
        proj["takes"] = [by_id[i] for i in body.order]
    return proj["takes"]


def _assemble(project_id: str) -> dict:
    """Join takes (in strip order) into per-speaker tracks and one transcript."""
    proj = get_project(project_id)
    project_dir = PROJECTS_DIR / project_id
    takes = [t for t in proj["takes"] if t["status"] == "ready"]
    participants = proj.get("participants", [])

    speakers = join_tracks(project_dir, takes, participants)
    take_transcripts = {t["id"]: read_take_transcript(project_dir / "takes" / t["id"]) for t in takes}
    per_speaker, merged, boundaries = combine_transcripts(takes, take_transcripts, participants)

    with editing_project(project_id) as proj:
        proj["speakers"] = speakers
        proj["transcripts"] = per_speaker
        proj["merged_transcript"] = merged
        proj["take_boundaries"] = boundaries
        proj["status"] = "transcribed"
        proj["progress"] = {"step": "done", "percent": 100, "message": "Transcription complete ✓"}
    return proj


@router.post("/projects/{project_id}/takes/finish")
async def finish_recording(project_id: str):
    proj = _load(project_id)
    takes = proj.get("takes", [])
    if any(t["status"] in ("recording", "finalizing") for t in takes):
        raise HTTPException(409, "Stop recording before finishing")
    ready = [t for t in takes if t["status"] == "ready"]
    if not ready:
        raise HTTPException(400, "Record at least one take first")
    if any(t["transcription"]["status"] != "done" for t in ready):
        raise HTTPException(409, "Some takes are still being transcribed")
    try:
        return await asyncio.to_thread(_assemble, project_id)
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))

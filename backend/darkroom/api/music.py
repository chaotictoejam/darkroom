"""
The global music library, and the cues a project places from it.

The library is shared by every project and lives outside `projects/`, so an
intro or a bed is imported once and reused. Nothing here reaches the network:
tracks are files the user picked, copied in and transcoded locally.
"""
import asyncio
import tempfile
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..services import library
from ..services.music import CUE_DEFAULTS, DEFAULT_TRACKS
from ..storage import editing_project
from .media import waveform_values

router = APIRouter()

# Containers worth trying. Anything FFmpeg can decode works; the list just keeps
# the file picker and the obvious mistakes (a video, a PDF) apart.
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus",
                  ".aiff", ".aif", ".aifc", ".wma", ".caf", ".mp4", ".mov", ".webm"}


# ── Library ───────────────────────────────────────────────────────────────────

@router.get("/library/music")
def get_library():
    """Every track in the library, newest first."""
    return {"tracks": library.list_tracks()}


@router.post("/library/music")
async def add_to_library(files: list[UploadFile] = File(...)):
    """
    Import audio files into the library: each is transcoded to stereo 48 kHz
    FLAC, measured, and indexed. Files that can't be decoded are reported
    individually so one bad file doesn't lose the rest.
    """
    added: list[dict] = []
    errors: list[dict] = []
    for upload in files:
        filename = upload.filename or "track"
        suffix = Path(filename).suffix.lower()
        if suffix and suffix not in AUDIO_SUFFIXES:
            errors.append({"name": filename, "error": f"{suffix} is not an audio file Darkroom imports"})
            continue
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / f"upload{suffix or '.bin'}"
            staged.write_bytes(await upload.read())
            try:
                added.append(await asyncio.to_thread(
                    library.import_track, staged, Path(filename).stem))
            except RuntimeError as exc:
                errors.append({"name": filename, "error": str(exc)})
    if not added and errors:
        raise HTTPException(400, errors[0]["error"])
    return {"added": added, "errors": errors, "tracks": library.list_tracks()}


class RenameTrackBody(BaseModel):
    name: str


@router.patch("/library/music/{track_id}")
def rename_library_track(track_id: str, body: RenameTrackBody):
    track = library.rename_track(track_id, body.name)
    if track is None:
        raise HTTPException(404, "Track not found")
    return track


@router.delete("/library/music/{track_id}")
def delete_library_track(track_id: str):
    """
    Remove a track from the library. Projects that still place it keep their
    cues, which show as missing in the editor until they are removed or pointed
    at another track.
    """
    if not library.delete_track(track_id):
        raise HTTPException(404, "Track not found")
    return {"ok": True}


@router.get("/library/music/{track_id}/file")
def get_library_file(track_id: str):
    track = library.get_track(track_id)
    if track is None:
        raise HTTPException(404, "Track not found")
    path = library.track_path(track)
    if not path.exists():
        raise HTTPException(404, "Track file is missing")
    return FileResponse(str(path), media_type="audio/flac",
                        headers={"Cache-Control": "max-age=31536000, immutable"})


@router.get("/library/music/{track_id}/waveform")
async def get_library_waveform(track_id: str, buckets: int = Query(400, ge=50, le=200_000)):
    track = library.get_track(track_id)
    if track is None:
        raise HTTPException(404, "Track not found")
    path = library.track_path(track)
    if not path.exists():
        raise HTTPException(404, "Track file is missing")
    return {"waveform": await asyncio.to_thread(waveform_values, path, buckets)}


# ── A project's cues ──────────────────────────────────────────────────────────

class CueBody(BaseModel):
    """
    One placement of a library track. Times are in **source** seconds, like
    chapters and word cuts, so a cue moves with the content as speech is cut.
    """
    id: Optional[str] = None
    library_id: str
    track: str = "music"
    kind: Literal["bed", "intro", "outro", "sfx"] = "bed"
    at: float = Field(default=0.0, ge=0)
    until: Optional[float] = Field(default=None, ge=0)
    length: Optional[float] = Field(default=None, gt=0)
    # Level relative to the voice: 0 dB is as loud as the speech.
    gain_db: float = Field(default=CUE_DEFAULTS["gain_db"], ge=-60, le=12)
    duck: bool = CUE_DEFAULTS["duck"]
    # How much further down the music goes while someone is talking.
    duck_db: float = Field(default=CUE_DEFAULTS["duck_db"], ge=-60, le=0)
    loop: bool = CUE_DEFAULTS["loop"]
    fade_in: float = Field(default=CUE_DEFAULTS["fade_in"], ge=0, le=30)
    fade_out: float = Field(default=CUE_DEFAULTS["fade_out"], ge=0, le=30)


class SoundTrackBody(BaseModel):
    id: str
    name: str = "Music"
    gain_db: float = Field(default=0.0, ge=-60, le=12)
    muted: bool = False


class SoundCuesBody(BaseModel):
    cues: list[CueBody]
    tracks: Optional[list[SoundTrackBody]] = None


@router.put("/projects/{project_id}/sound-cues")
def put_sound_cues(project_id: str, body: SoundCuesBody):
    """Replace a project's cues (and optionally its sound tracks)."""
    known = {t["id"] for t in library.list_tracks()}
    cues = []
    for cue in body.cues:
        if cue.library_id not in known:
            raise HTTPException(400, f"No library track {cue.library_id}")
        data = cue.model_dump()
        data["id"] = data["id"] or uuid.uuid4().hex[:8]
        if data["until"] is not None and data["until"] <= data["at"]:
            raise HTTPException(400, "A cue's `until` must be after its `at`")
        cues.append(data)
    try:
        with editing_project(project_id) as proj:
            proj["sound_cues"] = sorted(cues, key=lambda c: (c["kind"] != "intro", c["at"]))
            if body.tracks is not None:
                proj["sound_tracks"] = [t.model_dump() for t in body.tracks] or DEFAULT_TRACKS
    except LookupError:
        raise HTTPException(404, "Project not found")
    return proj

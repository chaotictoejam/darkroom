"""
The global music library — audio the user can place in any project.

The library lives outside `projects/` (``~/.darkroom/library`` by default, or
``DARKROOM_LIBRARY_DIR``) so an intro or a bed imported once is reusable across
projects and survives deleting one.  Nothing is downloaded or bundled: every
track is a file the user added, copied in so a render never depends on a file
somewhere else on disk.

Imports are transcoded to stereo 48 kHz FLAC (lossless, about half the size of
WAV, and playable in the editor) and measured once, so a cue's level can be set
relative to the voice rather than to whatever the source file happened to be.
"""
import json
import os
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

MUSIC_SUBDIR = "music"
_INDEX_NAME = "library.json"
_lock = threading.RLock()


def library_dir() -> Path:
    """Where the library lives. Read per call so tests can repoint it."""
    env = os.getenv("DARKROOM_LIBRARY_DIR")
    return Path(env) if env else Path.home() / ".darkroom" / "library"


def music_dir() -> Path:
    return library_dir() / MUSIC_SUBDIR


def _index_path() -> Path:
    return library_dir() / _INDEX_NAME


def load_index() -> dict:
    path = _index_path()
    if not path.exists():
        return {"tracks": []}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"tracks": []}
    data.setdefault("tracks", [])
    return data


def _save_index(index: dict) -> None:
    path = _index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    tmp.replace(path)


def list_tracks() -> list[dict]:
    """Every track in the library, newest first."""
    with _lock:
        return sorted(load_index()["tracks"], key=lambda t: t.get("added_at", ""), reverse=True)


def get_track(track_id: str) -> dict | None:
    with _lock:
        return next((t for t in load_index()["tracks"] if t["id"] == track_id), None)


def track_path(track: dict) -> Path:
    return library_dir() / track["file"]


def probe_duration(path: Path) -> float:
    cmd = ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def measure_loudness(path: Path) -> float | None:
    """
    Integrated loudness of a file in LUFS, or None when it is silent.

    Stored at import so a cue's `gain_db` can mean "this far under the voice"
    whatever the source file's own level was.
    """
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or "{" not in result.stderr:
        return None
    try:
        stats, _ = json.JSONDecoder().raw_decode(result.stderr, result.stderr.rindex("{"))
        loudness = float(stats["input_i"])
    except (ValueError, KeyError):
        return None
    return None if loudness <= -70 else loudness


def import_track(source: Path, name: str) -> dict:
    """
    Copy `source` into the library as stereo 48 kHz FLAC and index it.

    Raises RuntimeError with FFmpeg's complaint if the file has no audio
    Darkroom can read.
    """
    track_id = uuid.uuid4().hex[:8]
    dest_rel = f"{MUSIC_SUBDIR}/{track_id}.flac"
    dest = library_dir() / dest_rel
    dest.parent.mkdir(parents=True, exist_ok=True)

    cmd = ["ffmpeg", "-y", "-nostdin", "-i", str(source),
           "-vn", "-map", "a:0", "-ac", "2", "-ar", "48000", "-c:a", "flac", str(dest)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        dest.unlink(missing_ok=True)
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr else "ffmpeg failed")

    track = {
        "id": track_id,
        "name": name.strip() or dest.stem,
        "file": dest_rel,
        "duration": round(probe_duration(dest), 3),
        "loudness": measure_loudness(dest),
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    with _lock:
        index = load_index()
        index["tracks"].append(track)
        _save_index(index)
    return track


def rename_track(track_id: str, name: str) -> dict | None:
    with _lock:
        index = load_index()
        for track in index["tracks"]:
            if track["id"] == track_id:
                track["name"] = name.strip() or track["name"]
                _save_index(index)
                return track
    return None


def delete_track(track_id: str) -> bool:
    """Remove a track from the library and delete its file. Cues in projects that
    still name it are left alone and show as missing in the editor."""
    with _lock:
        index = load_index()
        track = next((t for t in index["tracks"] if t["id"] == track_id), None)
        if not track:
            return False
        index["tracks"] = [t for t in index["tracks"] if t["id"] != track_id]
        _save_index(index)
    track_path(track).unlink(missing_ok=True)
    return True

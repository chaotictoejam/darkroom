"""Recording studio takes: streamed chunks to disk, finalise, recovery, joining, transcript offsets."""
import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import projects as projects_api
from darkroom.api import takes as takes_api
from darkroom.services import renderer
from darkroom.services.takes import (
    ChunkOffsetError,
    append_chunk,
    combine_transcripts,
    finalise_take,
    join_tracks,
    probe_duration,
)

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _streamed_webm(seconds: float, freq: int = 440) -> bytes:
    """What MediaRecorder produces: WebM/Opus written to a pipe, so no duration in the header."""
    return subprocess.run(
        ["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}",
         "-c:a", "libopus", "-f", "webm", "pipe:1"],
        capture_output=True, check=True,
    ).stdout


def _wav(path, seconds: float) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"sine=duration={seconds}",
                    "-ac", "1", "-ar", "48000", str(path)], check=True)


def _seg(start, end, text="hello", pid="A"):
    return {"speaker_id": pid, "speaker_name": pid, "start": start, "end": end, "text": text,
            "words": [{"word": " " + text, "start": start, "end": end}]}


# ── Chunk append ──────────────────────────────────────────────────────────────

def test_chunks_append_in_order_and_resends_are_ignored(tmp_path):
    path = tmp_path / "mic_A.part"
    assert append_chunk(path, 0, b"abc") == 3
    assert append_chunk(path, 3, b"def") == 6
    # The response to the last chunk was lost and the browser sends it again
    assert append_chunk(path, 3, b"def") == 6
    assert path.read_bytes() == b"abcdef"


def test_chunk_after_a_gap_is_rejected(tmp_path):
    path = tmp_path / "mic_A.part"
    append_chunk(path, 0, b"abc")
    with pytest.raises(ChunkOffsetError) as exc:
        append_chunk(path, 10, b"xyz")
    assert exc.value.size == 3
    assert path.read_bytes() == b"abc"


# ── Finalise ──────────────────────────────────────────────────────────────────

def test_finalise_converts_streamed_recording_to_wav(tmp_path):
    data = _streamed_webm(2)
    part = tmp_path / "mic_A.part"
    # Arrives in arbitrary pieces, like 1-second MediaRecorder chunks
    for i in range(0, len(data), 1000):
        append_chunk(part, i, data[i:i + 1000])

    result = finalise_take(tmp_path)

    assert result["tracks"] == {"A": "mic_A.wav"}
    assert result["duration"] == pytest.approx(2.0, abs=0.1)
    assert not part.exists()
    out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "stream=codec_name,sample_rate,channels",
                          "-of", "json", str(tmp_path / "mic_A.wav")], capture_output=True, text=True).stdout
    stream = json.loads(out)["streams"][0]
    assert stream == {"codec_name": "pcm_s16le", "sample_rate": "48000", "channels": 1}


def test_finalise_recovers_a_recording_cut_off_by_a_crash(tmp_path):
    data = _streamed_webm(4)
    (tmp_path / "mic_A.part").write_bytes(data[: len(data) // 2])

    result = finalise_take(tmp_path)

    assert result["tracks"] == {"A": "mic_A.wav"}
    assert 0.5 < result["duration"] < 4


def test_finalise_skips_empty_and_undecodable_tracks(tmp_path):
    (tmp_path / "mic_A.part").write_bytes(_streamed_webm(1))
    (tmp_path / "mic_B.part").write_bytes(b"")
    (tmp_path / "mic_C.part").write_bytes(b"garbage")

    result = finalise_take(tmp_path)

    assert result["tracks"] == {"A": "mic_A.wav"}
    assert set(result["errors"]) == {"C"}


def test_finalise_is_safe_to_run_twice(tmp_path):
    (tmp_path / "mic_A.part").write_bytes(_streamed_webm(1))
    first = finalise_take(tmp_path)
    assert finalise_take(tmp_path)["tracks"] == first["tracks"]


# ── Joining takes ─────────────────────────────────────────────────────────────

def test_join_pads_missing_sources_and_keeps_tracks_aligned(tmp_path):
    for take, mics in (("take_001", {"A": 2.0, "B": 1.9}), ("take_002", {"A": 1.0})):
        d = tmp_path / "takes" / take
        d.mkdir(parents=True)
        for pid, secs in mics.items():
            _wav(d / f"mic_{pid}.wav", secs)
    takes = [
        {"id": "take_001", "duration": 2.0, "tracks": {"A": "mic_A.wav", "B": "mic_B.wav"}},
        {"id": "take_002", "duration": 1.0, "tracks": {"A": "mic_A.wav"}},
    ]

    speakers = join_tracks(tmp_path, takes, [{"id": "A", "name": "Alice"}, {"id": "B", "name": "Bob"}])

    assert [(s["id"], s["name"], s["file"]) for s in speakers] == [
        ("A", "Alice", "cam_A.wav"), ("B", "Bob", "cam_B.wav"),
    ]
    # Bob's short first take is padded and he gets silence for take 2
    assert probe_duration(tmp_path / "cam_A.wav") == pytest.approx(3.0, abs=0.01)
    assert probe_duration(tmp_path / "cam_B.wav") == pytest.approx(3.0, abs=0.01)


def test_transcripts_are_offset_by_take_position_and_follow_the_order():
    takes = [{"id": "take_002", "duration": 5.0}, {"id": "take_001", "duration": 10.0}]
    transcripts = {
        "take_001": {"A": [_seg(1.0, 2.0, "first")]},
        "take_002": {"A": [_seg(0.5, 1.5, "second")], "B": [_seg(3.0, 4.0, "bob", "B")]},
    }

    per_speaker, merged, boundaries = combine_transcripts(
        takes, transcripts, [{"id": "A", "name": "Alice"}, {"id": "B", "name": "Bob"}])

    assert [(s["text"], s["start"], s["speaker_name"]) for s in merged] == [
        ("second", 0.5, "Alice"), ("bob", 3.0, "Bob"), ("first", 6.0, "Alice"),
    ]
    assert per_speaker["A"][1]["words"][0] == {"word": " first", "start": 6.0, "end": 7.0}
    assert boundaries == [
        {"take_id": "take_002", "start": 0.0, "end": 5.0},
        {"take_id": "take_001", "start": 5.0, "end": 15.0},
    ]


# ── API flow ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    for module in (storage, projects_api, takes_api):
        monkeypatch.setattr(module, "PROJECTS_DIR", tmp_path)

    def fake_transcribe(path, pid, name, model, language=None, progress_callback=None):
        return [_seg(0.2, 0.8, f"{name} speaking", pid)]

    monkeypatch.setattr(takes_api, "transcribe_file", fake_transcribe)
    from darkroom.main import app
    return TestClient(app)


def _record_take(client, pid, participants, seconds):
    take = client.post(f"/api/projects/{pid}/takes", json={"participants": participants}).json()
    for p in participants:
        data = _streamed_webm(seconds)
        offset = 0
        for i in range(0, len(data), 4000):
            chunk = data[i:i + 4000]
            r = client.post(f"/api/projects/{pid}/takes/{take['id']}/mic_{p['id']}/chunk?offset={offset}",
                            content=chunk)
            assert r.status_code == 200, r.text
            offset += len(chunk)
    stopped = client.post(f"/api/projects/{pid}/takes/{take['id']}/stop").json()
    takes_api._transcribe_queue.join()
    return stopped


def test_record_takes_reorder_and_finish(client, tmp_path):
    proj = client.post("/api/projects", json={"name": "Ep 1", "project_type": "podcast", "source": "record"}).json()
    assert proj["status"] == "recording"
    pid = proj["id"]
    both = [{"id": "A", "name": "Alice"}, {"id": "B", "name": "Bob"}]

    t1 = _record_take(client, pid, both, 2)
    t2 = _record_take(client, pid, [{"id": "A", "name": "Alice"}], 1)
    assert t1["status"] == "ready" and t1["tracks"] == {"A": "mic_A.wav", "B": "mic_B.wav"}

    takes = client.get(f"/api/projects/{pid}").json()["takes"]
    assert [t["transcription"]["status"] for t in takes] == ["done", "done"]

    r = client.put(f"/api/projects/{pid}/takes/order", json={"order": [t2["id"], t1["id"]]})
    assert r.status_code == 200

    done = client.post(f"/api/projects/{pid}/takes/finish").json()

    assert done["status"] == "transcribed"
    assert [s["file"] for s in done["speakers"]] == ["cam_A.wav", "cam_B.wav"]
    assert [b["take_id"] for b in done["take_boundaries"]] == [t2["id"], t1["id"]]
    # Take 1 now comes second, so its transcript is shifted by take 2's length
    bob = [s for s in done["merged_transcript"] if s["speaker_id"] == "B"]
    assert bob[0]["start"] == pytest.approx(0.2 + t2["duration"], abs=0.01)
    assert probe_duration(tmp_path / pid / "cam_B.wav") == pytest.approx(t1["duration"] + t2["duration"], abs=0.02)


def test_finish_waits_for_transcription(client, monkeypatch):
    pid = client.post("/api/projects", json={"source": "record", "project_type": "podcast"}).json()["id"]
    monkeypatch.setattr(takes_api, "_enqueue_transcription", lambda *a: None)
    _record_take(client, pid, [{"id": "A", "name": "Alice"}], 1)

    assert client.post(f"/api/projects/{pid}/takes/finish").status_code == 409


def test_chunks_are_refused_once_a_take_has_stopped(client):
    pid = client.post("/api/projects", json={"source": "record", "project_type": "podcast"}).json()["id"]
    take = _record_take(client, pid, [{"id": "A", "name": "Alice"}], 1)
    r = client.post(f"/api/projects/{pid}/takes/{take['id']}/mic_A/chunk?offset=0", content=b"x")
    assert r.status_code == 409


def test_delete_take_removes_files(client, tmp_path):
    pid = client.post("/api/projects", json={"source": "record", "project_type": "podcast"}).json()["id"]
    take = _record_take(client, pid, [{"id": "A", "name": "Alice"}], 1)
    client.delete(f"/api/projects/{pid}/takes/{take['id']}")
    assert client.get(f"/api/projects/{pid}").json()["takes"] == []
    assert not (tmp_path / pid / "takes" / take["id"]).exists()


def test_unfinished_take_is_recovered_on_startup(client, tmp_path):
    pid = client.post("/api/projects", json={"source": "record", "project_type": "podcast"}).json()["id"]
    take = client.post(f"/api/projects/{pid}/takes", json={"participants": [{"id": "A", "name": "Alice"}]}).json()
    data = _streamed_webm(3)
    client.post(f"/api/projects/{pid}/takes/{take['id']}/mic_A/chunk?offset=0", content=data[: len(data) // 2])
    # ...and the app dies before Stop

    takes_api.recover_unfinished_takes()
    takes_api._transcribe_queue.join()

    recovered = client.get(f"/api/projects/{pid}").json()["takes"][0]
    assert recovered["status"] == "ready"
    assert recovered["recovered"] is True
    assert recovered["duration"] > 0.5
    assert recovered["transcription"]["status"] == "done"

    kept = client.post(f"/api/projects/{pid}/takes/{take['id']}/keep").json()
    assert kept["recovered"] is False


# ── MP3 export ────────────────────────────────────────────────────────────────

def test_audio_project_exports_mp3_with_cuts(tmp_path):
    _wav(tmp_path / "cam_A.wav", 4)
    _wav(tmp_path / "cam_B.wav", 4)
    speakers = {
        "A": {"id": "A", "file_path": str(tmp_path / "cam_A.wav")},
        "B": {"id": "B", "file_path": str(tmp_path / "cam_B.wav")},
    }
    segments = [{"start": 0, "end": 3, "keep": True, "camera": "A"},
                {"start": 3, "end": 4, "keep": False, "camera": "A"}]
    out = tmp_path / "fullEdit.mp3"

    renderer._render_audio(segments, speakers, [{"start": 1, "end": 2}], [{"start": 0.2, "end": 0.4}],
                           str(out), "mp3")

    assert probe_duration(out) == pytest.approx(2.0, abs=0.1)

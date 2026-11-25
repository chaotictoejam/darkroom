"""Re-transcribing a range: a window is re-decoded and spliced into the transcript.

A full-track pass can drop or mis-hear a stretch of speech. These cover the
endpoint that fixes one range without re-transcribing the project, with the
Whisper call stubbed so no model is needed.
"""
import pytest
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import jobs as jobs_api
from darkroom.main import app


def _seg(speaker, *spec):
    words = [{"word": " " + w, "start": s, "end": e} for w, s, e in spec]
    return {
        "speaker_id": speaker, "speaker_name": "Ana", "start": words[0]["start"],
        "end": words[-1]["end"], "text": "".join(w["word"] for w in words).strip(), "words": words,
    }


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project with a 32 s hole in the transcript, and a cut over part of it."""
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("ep", source="record")
    proj["speakers"] = [{"id": "A", "name": "Ana", "file": "cam_A.wav",
                         "file_path": str(tmp_path / "cam_A.wav")}]
    proj["status"] = "transcribed"
    proj["transcribe_model"] = "small"
    proj["transcribe_language"] = "en"
    before = _seg("A", ("Before", 60.0, 63.5))
    after = _seg("A", ("After", 95.9, 99.0))
    proj["merged_transcript"] = [before, after]
    proj["transcripts"] = {"A": [before, after]}
    proj["word_cuts"] = [{"start": 61.47, "end": 82.97}]
    storage.save_project(proj)
    return proj


@pytest.fixture
def recovered(monkeypatch):
    """Stub the Whisper call; records the arguments it was given."""
    calls = []

    def _fake(file_path, speaker_id, speaker_name, start, end, model_name=None, language=None):
        calls.append({"path": file_path, "speaker": speaker_id, "start": start,
                      "end": end, "model": model_name, "language": language})
        return [_seg(speaker_id, ("Recovered", 65.5, 70.0), ("speech", 70.0, 76.8))]

    monkeypatch.setattr(jobs_api, "transcribe_range", _fake)
    return calls


def test_range_is_decoded_and_spliced_in(project, recovered):
    client = TestClient(app)
    r = client.post(f"/api/projects/{project['id']}/retranscribe",
                    json={"start": 63.5, "end": 95.9})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["segments"] == 1
    assert body["words_before"] == 0 and body["words_after"] == 2
    assert body["model"] == "small"

    saved = storage.get_project(project["id"])
    assert [s["text"] for s in saved["merged_transcript"]] == ["Before", "Recovered speech", "After"]
    # The per-speaker transcripts stay in step with the merged one
    assert [s["text"] for s in saved["transcripts"]["A"]] == ["Before", "Recovered speech", "After"]
    # The project keeps its status, so the editor stays where it is
    assert saved["status"] == "transcribed"
    assert recovered[0]["start"] == 63.5 and recovered[0]["end"] == 95.9
    assert recovered[0]["model"] == "small" and recovered[0]["language"] == "en"


def test_manual_cuts_are_left_alone(project, recovered):
    client = TestClient(app)
    client.post(f"/api/projects/{project['id']}/retranscribe", json={"start": 63.5, "end": 95.9})
    # Recovered speech inside a cut stays cut until the user restores it
    assert storage.get_project(project["id"])["word_cuts"] == [{"start": 61.47, "end": 82.97}]


def test_a_model_can_be_chosen_for_the_retry(project, recovered):
    client = TestClient(app)
    r = client.post(f"/api/projects/{project['id']}/retranscribe",
                    json={"start": 63.5, "end": 95.9, "model": "turbo"})
    assert r.json()["model"] == "turbo"
    assert recovered[0]["model"] == "turbo"


def test_one_speaker_can_be_singled_out(project, recovered):
    project["speakers"].append({"id": "B", "name": "Bo", "file": "cam_B.wav", "file_path": "cam_B.wav"})
    storage.save_project(project)
    client = TestClient(app)
    r = client.post(f"/api/projects/{project['id']}/retranscribe",
                    json={"start": 63.5, "end": 95.9, "speaker_id": "B"})
    assert r.status_code == 200
    assert [c["speaker"] for c in recovered] == ["B"]


def test_every_speaker_by_default(project, recovered):
    project["speakers"].append({"id": "B", "name": "Bo", "file": "cam_B.wav", "file_path": "cam_B.wav"})
    storage.save_project(project)
    client = TestClient(app)
    client.post(f"/api/projects/{project['id']}/retranscribe", json={"start": 63.5, "end": 95.9})
    assert [c["speaker"] for c in recovered] == ["A", "B"]


def test_words_before_counts_what_was_replaced(project, recovered):
    project["merged_transcript"].insert(1, _seg("A", ("mis", 70.0, 71.0), ("heard", 71.0, 72.0)))
    storage.save_project(project)
    client = TestClient(app)
    r = client.post(f"/api/projects/{project['id']}/retranscribe", json={"start": 63.5, "end": 95.9})
    assert r.json()["words_before"] == 2


@pytest.mark.parametrize("body, expected", [
    ({"start": 10.0, "end": 10.01}, "too short"),
    ({"start": 0.0, "end": 3600.0}, "longer than"),
])
def test_bad_ranges_are_refused(project, recovered, body, expected):
    client = TestClient(app)
    r = client.post(f"/api/projects/{project['id']}/retranscribe", json=body)
    assert r.status_code == 400 and expected in r.json()["detail"]
    assert recovered == []


def test_unknown_project_and_speaker(project, recovered):
    client = TestClient(app)
    assert client.post("/api/projects/nope/retranscribe", json={"start": 1.0, "end": 2.0}).status_code == 404
    r = client.post(f"/api/projects/{project['id']}/retranscribe",
                    json={"start": 1.0, "end": 2.0, "speaker_id": "Z"})
    assert r.status_code == 404


def test_a_failed_decode_is_reported(project, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("model is missing")

    monkeypatch.setattr(jobs_api, "transcribe_range", _boom)
    client = TestClient(app)
    r = client.post(f"/api/projects/{project['id']}/retranscribe", json={"start": 63.5, "end": 95.9})
    assert r.status_code == 500 and "model is missing" in r.json()["detail"]
    # Nothing was written
    assert len(storage.get_project(project["id"])["merged_transcript"]) == 2

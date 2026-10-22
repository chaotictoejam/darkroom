"""Renaming a speaker updates every copy of the name in the project."""
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.main import app


def _project(tmp_path, monkeypatch) -> dict:
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    proj["speakers"] = [{"id": "A", "name": "Speaker A"}, {"id": "B", "name": "Speaker B"}]
    proj["participants"] = [{"id": "A", "name": "Speaker A"}, {"id": "B", "name": "Speaker B"}]
    seg_a = {"speaker_id": "A", "speaker_name": "Speaker A", "start": 0.0, "end": 1.0, "text": "hi"}
    seg_b = {"speaker_id": "B", "speaker_name": "Speaker B", "start": 1.0, "end": 2.0, "text": "hey"}
    proj["transcripts"] = {"A": [dict(seg_a)], "B": [dict(seg_b)]}
    proj["merged_transcript"] = [dict(seg_a), dict(seg_b)]
    storage.save_project(proj)
    return proj


def test_rename_updates_speaker_participant_and_segments(tmp_path, monkeypatch):
    proj = _project(tmp_path, monkeypatch)
    r = TestClient(app).patch(f"/api/projects/{proj['id']}/speakers/A", json={"name": "  Joanne "})
    assert r.status_code == 200

    saved = storage.get_project(proj["id"])
    assert saved["speakers"][0]["name"] == "Joanne"
    assert saved["participants"][0]["name"] == "Joanne"
    assert saved["transcripts"]["A"][0]["speaker_name"] == "Joanne"
    assert [s["speaker_name"] for s in saved["merged_transcript"]] == ["Joanne", "Speaker B"]
    assert saved["speakers"][1]["name"] == "Speaker B"


def test_rename_rejects_bad_input(tmp_path, monkeypatch):
    proj = _project(tmp_path, monkeypatch)
    client = TestClient(app)
    assert client.patch(f"/api/projects/{proj['id']}/speakers/A", json={"name": "  "}).status_code == 400
    assert client.patch(f"/api/projects/{proj['id']}/speakers/A", json={"name": "x" * 61}).status_code == 422
    assert client.patch(f"/api/projects/{proj['id']}/speakers/D", json={"name": "Sam"}).status_code == 404
    assert client.patch("/api/projects/nope/speakers/A", json={"name": "Sam"}).status_code == 404
    assert storage.get_project(proj["id"])["speakers"][0]["name"] == "Speaker A"

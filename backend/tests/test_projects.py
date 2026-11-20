"""Project PATCH: timeline splits are saved sorted, de-duplicated and non-negative."""
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.main import app


def test_patch_saves_timeline_splits(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    storage.save_project(proj)
    client = TestClient(app)

    r = client.patch(f"/api/projects/{proj['id']}", json={"timeline_splits": [12.5, 3.25, 12.5, -1, 7.12345]})
    assert r.status_code == 200
    assert storage.get_project(proj["id"])["timeline_splits"] == [3.25, 7.123, 12.5]

    # Other fields leave the splits alone
    client.patch(f"/api/projects/{proj['id']}", json={"name": "Renamed"})
    assert storage.get_project(proj["id"])["timeline_splits"] == [3.25, 7.123, 12.5]


def test_old_projects_backfill_timeline_splits(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    del proj["timeline_splits"]
    storage.save_project(proj)
    assert storage.get_project(proj["id"])["timeline_splits"] == []


def test_patch_switches_a_video_project_to_audio_only(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    proj["project_type"] = "video"
    proj["has_video"] = True
    storage.save_project(proj)
    client = TestClient(app)

    assert client.patch(f"/api/projects/{proj['id']}", json={"project_type": "podcast"}).status_code == 200
    saved = storage.get_project(proj["id"])
    assert saved["project_type"] == "podcast"
    assert saved["has_video"] is True  # the media still has video, so it can switch back

    assert client.patch(f"/api/projects/{proj['id']}", json={"project_type": "video"}).status_code == 200
    assert storage.get_project(proj["id"])["project_type"] == "video"


def test_audio_only_media_cannot_be_switched_to_video(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    proj["project_type"] = "podcast"
    proj["has_video"] = False
    storage.save_project(proj)

    r = TestClient(app).patch(f"/api/projects/{proj['id']}", json={"project_type": "video"})
    assert r.status_code == 400
    assert storage.get_project(proj["id"])["project_type"] == "podcast"


def test_old_projects_backfill_has_video_from_their_type(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    del proj["has_video"]
    proj["project_type"] = "video"
    storage.save_project(proj)
    assert storage.get_project(proj["id"])["has_video"] is None
    client = TestClient(app)

    # Switching records what the detected type already told us about the media
    assert client.patch(f"/api/projects/{proj['id']}", json={"project_type": "podcast"}).status_code == 200
    assert storage.get_project(proj["id"])["has_video"] is True

    # A project detected as a podcast has no video to go back to, and a refused
    # switch changes nothing
    audio = storage.new_project("a")
    del audio["has_video"]
    audio["project_type"] = "podcast"
    storage.save_project(audio)
    assert client.patch(f"/api/projects/{audio['id']}", json={"project_type": "video"}).status_code == 400
    saved = storage.get_project(audio["id"])
    assert (saved["project_type"], saved["has_video"]) == ("podcast", None)

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

"""Project groups: the label on a project, listing groups, renaming and ungrouping."""
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.main import app


def _project(name: str, group: str = "") -> dict:
    proj = storage.new_project(name, group=group)
    storage.save_project(proj)
    return proj


def test_create_and_patch_set_the_group(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    client = TestClient(app)

    created = client.post("/api/projects", json={"name": "Ep 1", "group": "  chaoticcommits  "}).json()
    assert created["group"] == "chaoticcommits"  # trimmed

    # Moved to another group, then out of it again
    assert client.patch(f"/api/projects/{created['id']}", json={"group": "side quests"}).status_code == 200
    assert storage.get_project(created["id"])["group"] == "side quests"
    assert client.patch(f"/api/projects/{created['id']}", json={"group": ""}).status_code == 200
    assert storage.get_project(created["id"])["group"] == ""

    # Not sending a group leaves it alone
    client.patch(f"/api/projects/{created['id']}", json={"group": "chaoticcommits"})
    client.patch(f"/api/projects/{created['id']}", json={"name": "Ep 2"})
    assert storage.get_project(created["id"])["group"] == "chaoticcommits"


def test_old_projects_backfill_an_empty_group(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    del proj["group"]
    storage.save_project(proj)
    assert storage.get_project(proj["id"])["group"] == ""


def test_project_list_includes_the_group(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr("darkroom.api.projects.PROJECTS_DIR", tmp_path)
    _project("Ep 1", "chaoticcommits")
    _project("Loose end")

    listed = TestClient(app).get("/api/projects").json()
    assert {p["name"]: p["group"] for p in listed} == {"Ep 1": "chaoticcommits", "Loose end": ""}


def test_groups_are_listed_alphabetically_with_counts(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    _project("Ep 1", "chaoticcommits")
    _project("Ep 2", "chaoticcommits")
    _project("Talk", "Zine")
    _project("Loose end")

    assert TestClient(app).get("/api/groups").json() == [
        {"name": "chaoticcommits", "count": 2},
        {"name": "Zine", "count": 1},
    ]


def test_renaming_a_group_moves_all_its_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    a = _project("Ep 1", "chaoticcommits")
    b = _project("Ep 2", "CHAOTICCOMMITS")  # matched regardless of case
    other = _project("Talk", "Zine")
    client = TestClient(app)

    r = client.post("/api/groups/rename", json={"old": "chaoticcommits", "new": "  Chaotic Commits  "})
    assert r.status_code == 200
    assert r.json()["moved"] == 2
    assert storage.get_project(a["id"])["group"] == "Chaotic Commits"
    assert storage.get_project(b["id"])["group"] == "Chaotic Commits"
    assert storage.get_project(other["id"])["group"] == "Zine"

    # An empty new name ungroups them instead
    assert client.post("/api/groups/rename", json={"old": "Chaotic Commits", "new": ""}).json()["moved"] == 2
    assert storage.get_project(a["id"])["group"] == ""


def test_ungrouping_keeps_the_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    a = _project("Ep 1", "chaoticcommits")
    client = TestClient(app)

    r = client.post("/api/groups/ungroup", json={"name": "chaoticcommits"})
    assert r.status_code == 200
    assert r.json() == {"moved": 1, "groups": []}
    assert storage.get_project(a["id"])["group"] == ""


def test_unknown_and_empty_groups_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    client = TestClient(app)

    assert client.post("/api/groups/rename", json={"old": "nope", "new": "x"}).status_code == 404
    assert client.post("/api/groups/ungroup", json={"name": "nope"}).status_code == 404
    assert client.post("/api/groups/rename", json={"old": " ", "new": "x"}).status_code == 400
    assert client.post("/api/groups/ungroup", json={"name": " "}).status_code == 400

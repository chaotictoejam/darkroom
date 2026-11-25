"""The library routes and a project's cues."""
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import jobs
from darkroom.main import app

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DARKROOM_LIBRARY_DIR", str(tmp_path / "lib"))
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _wav(path: Path, seconds: float = 2.0) -> Path:
    subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-f", "lavfi",
                    "-i", f"sine=frequency=330:duration={seconds}", str(path)], check=True)
    return path


def _upload(client, path: Path):
    with open(path, "rb") as f:
        return client.post("/api/library/music", files={"files": (path.name, f, "audio/wav")})


def test_the_library_starts_empty(client):
    assert client.get("/api/library/music").json() == {"tracks": []}


def test_importing_a_track_names_it_after_the_file(client, tmp_path):
    res = _upload(client, _wav(tmp_path / "Late Afternoon Loop.wav"))
    assert res.status_code == 200, res.text
    track = res.json()["added"][0]
    assert track["name"] == "Late Afternoon Loop"
    assert track["duration"] == pytest.approx(2.0, abs=0.05)
    assert res.json()["errors"] == []
    assert [t["id"] for t in client.get("/api/library/music").json()["tracks"]] == [track["id"]]


def test_the_library_is_shared_by_every_project(client, tmp_path):
    """Nothing about a track is tied to a project — that is the point of it."""
    track = _upload(client, _wav(tmp_path / "theme.wav")).json()["added"][0]
    first = client.post("/api/projects", json={"name": "One", "project_type": "podcast"}).json()
    second = client.post("/api/projects", json={"name": "Two", "project_type": "podcast"}).json()
    for project in (first, second):
        res = client.put(f"/api/projects/{project['id']}/sound-cues",
                         json={"cues": [{"library_id": track["id"], "kind": "intro"}]})
        assert res.status_code == 200, res.text
        assert res.json()["sound_cues"][0]["library_id"] == track["id"]


def test_a_file_that_is_not_audio_is_refused(client, tmp_path):
    junk = tmp_path / "notes.txt"
    junk.write_text("hello")
    assert _upload(client, junk).status_code == 400


def test_one_bad_file_does_not_lose_the_good_ones(client, tmp_path):
    good = _wav(tmp_path / "good.wav")
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"nope")
    with open(good, "rb") as f1, open(bad, "rb") as f2:
        res = client.post("/api/library/music", files=[
            ("files", (good.name, f1, "audio/wav")),
            ("files", (bad.name, f2, "audio/mpeg")),
        ])
    assert res.status_code == 200, res.text
    assert len(res.json()["added"]) == 1
    assert [e["name"] for e in res.json()["errors"]] == ["bad.mp3"]


def test_renaming_and_deleting_through_the_api(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]

    assert client.patch(f"/api/library/music/{track['id']}",
                        json={"name": "Renamed"}).json()["name"] == "Renamed"
    assert client.patch("/api/library/music/nope", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/library/music/{track['id']}").json() == {"ok": True}
    assert client.delete(f"/api/library/music/{track['id']}").status_code == 404
    assert client.get("/api/library/music").json()["tracks"] == []


def test_a_tracks_file_and_waveform_are_served(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]

    res = client.get(f"/api/library/music/{track['id']}/file")
    assert res.status_code == 200 and res.headers["content-type"] == "audio/flac"

    wave = client.get(f"/api/library/music/{track['id']}/waveform?buckets=64").json()["waveform"]
    assert len(wave) == 64 and max(wave) == pytest.approx(1.0)

    assert client.get("/api/library/music/nope/file").status_code == 404
    assert client.get("/api/library/music/nope/waveform").status_code == 404


def test_cues_are_given_ids_and_sorted_with_the_intro_first(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    project = client.post("/api/projects", json={"name": "P", "project_type": "podcast"}).json()

    res = client.put(f"/api/projects/{project['id']}/sound-cues", json={"cues": [
        {"library_id": track["id"], "kind": "bed", "at": 30.0, "until": 60.0},
        {"library_id": track["id"], "kind": "sfx", "at": 10.0},
        {"library_id": track["id"], "kind": "intro"},
    ]})
    cues = res.json()["sound_cues"]
    assert [c["kind"] for c in cues] == ["intro", "sfx", "bed"]
    assert all(c["id"] for c in cues)
    assert len({c["id"] for c in cues}) == 3


def test_a_cue_keeps_its_id_across_saves(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    project = client.post("/api/projects", json={"name": "P"}).json()
    cue = client.put(f"/api/projects/{project['id']}/sound-cues",
                     json={"cues": [{"library_id": track["id"]}]}).json()["sound_cues"][0]

    again = client.put(f"/api/projects/{project['id']}/sound-cues", json={
        "cues": [{**cue, "gain_db": -20.0}]}).json()["sound_cues"][0]
    assert again["id"] == cue["id"] and again["gain_db"] == -20.0


def test_cue_levels_are_kept_inside_a_sane_range(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    project = client.post("/api/projects", json={"name": "P"}).json()
    url = f"/api/projects/{project['id']}/sound-cues"

    assert client.put(url, json={"cues": [{"library_id": track["id"], "gain_db": 40}]}).status_code == 422
    assert client.put(url, json={"cues": [{"library_id": track["id"], "duck_db": 6}]}).status_code == 422
    assert client.put(url, json={"cues": [{"library_id": track["id"], "at": -1}]}).status_code == 422
    assert client.put(url, json={"cues": [{"library_id": track["id"], "kind": "sting"}]}).status_code == 422


def test_a_bed_must_end_after_it_starts(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    project = client.post("/api/projects", json={"name": "P"}).json()
    res = client.put(f"/api/projects/{project['id']}/sound-cues",
                     json={"cues": [{"library_id": track["id"], "at": 30.0, "until": 10.0}]})
    assert res.status_code == 400


def test_a_cue_must_name_a_track_in_the_library(client):
    project = client.post("/api/projects", json={"name": "P"}).json()
    res = client.put(f"/api/projects/{project['id']}/sound-cues",
                     json={"cues": [{"library_id": "ghost"}]})
    assert res.status_code == 400
    assert client.put("/api/projects/nothere/sound-cues", json={"cues": []}).status_code == 404


def test_sound_tracks_can_be_muted_and_gained(client, tmp_path):
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    project = client.post("/api/projects", json={"name": "P"}).json()
    res = client.put(f"/api/projects/{project['id']}/sound-cues", json={
        "cues": [{"library_id": track["id"]}],
        "tracks": [{"id": "music", "name": "Music", "gain_db": -3.0, "muted": True}],
    })
    assert res.json()["sound_tracks"] == [
        {"id": "music", "name": "Music", "gain_db": -3.0, "muted": True}]


def test_a_new_project_starts_with_a_music_track_and_no_cues(client):
    project = client.post("/api/projects", json={"name": "P"}).json()
    assert project["sound_cues"] == []
    assert project["sound_tracks"] == [
        {"id": "music", "name": "Music", "gain_db": 0.0, "muted": False}]


def test_each_project_gets_its_own_cue_list(client, tmp_path):
    """A shared default list would leak one project's cues into the next."""
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    first = client.post("/api/projects", json={"name": "One"}).json()
    second = client.post("/api/projects", json={"name": "Two"}).json()
    client.put(f"/api/projects/{first['id']}/sound-cues", json={"cues": [{"library_id": track["id"]}]})
    assert client.get(f"/api/projects/{second['id']}").json()["sound_cues"] == []


def test_an_audio_only_project_previews_only_once_it_has_music(client, tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "check_ffmpeg", lambda: True)
    monkeypatch.setattr(jobs, "render_preview",
                        lambda project, projects_dir: {"url": "/x.m4a", "status": "ready"})
    jobs._preview_jobs.clear()
    track = _upload(client, _wav(tmp_path / "a.wav")).json()["added"][0]
    project = client.post("/api/projects", json={"name": "P", "project_type": "podcast"}).json()

    assert client.post(f"/api/projects/{project['id']}/preview").status_code == 400

    client.put(f"/api/projects/{project['id']}/sound-cues", json={"cues": [{"library_id": track["id"]}]})
    assert client.post(f"/api/projects/{project['id']}/preview").status_code == 200

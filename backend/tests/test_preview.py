"""The proxy preview job: one render at a time, with the next one queued.

Returning 409 while a render ran left the editor on a stale proxy, so later cuts
never reached the preview.
"""
import threading

from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import jobs
from darkroom.main import app


def _video_project(tmp_path, monkeypatch) -> str:
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr(jobs, "check_ffmpeg", lambda: True)
    jobs._preview_jobs.clear()
    proj = storage.new_project("t")
    proj["speakers"] = [{"id": "A", "name": "A", "file": "cam_A.mp4", "file_path": "cam_A.mp4"}]
    storage.save_project(proj)
    return proj["id"]


def test_second_request_during_a_render_is_queued_and_re_renders(tmp_path, monkeypatch):
    pid = _video_project(tmp_path, monkeypatch)
    started = threading.Semaphore(0)
    release = threading.Event()
    word_cuts: list[list] = []

    def fake_render(project, projects_dir):
        word_cuts.append(project["word_cuts"])
        started.release()
        release.wait(10)
        return {"status": "ready", "url": f"/projects/{project['id']}/files/output/preview_1.mp4"}

    monkeypatch.setattr(jobs, "render_preview", fake_render)
    client = TestClient(app)

    assert client.post(f"/api/projects/{pid}/preview").json() == {"message": "Preview render started"}
    assert started.acquire(timeout=10)

    # A cut made while the first render runs must still reach the next one
    with storage.editing_project(pid) as proj:
        proj["word_cuts"] = [{"start": 1.0, "end": 2.0}]
    assert client.post(f"/api/projects/{pid}/preview").json() == {"message": "Preview render queued"}
    # Extra requests coalesce into that one queued render
    client.post(f"/api/projects/{pid}/preview")

    release.set()
    assert started.acquire(timeout=10)
    assert word_cuts == [[], [{"start": 1.0, "end": 2.0}]]

    # The worker stops once nothing is pending
    for _ in range(100):
        if not jobs._preview_jobs[pid]["running"]:
            break
        threading.Event().wait(0.05)
    assert jobs._preview_jobs[pid] == {"running": False, "pending": False}


def test_a_failed_render_does_not_wedge_later_ones(tmp_path, monkeypatch):
    pid = _video_project(tmp_path, monkeypatch)
    calls = threading.Semaphore(0)

    def fake_render(project, projects_dir):
        calls.release()
        raise RuntimeError("ffmpeg died")

    monkeypatch.setattr(jobs, "render_preview", fake_render)
    client = TestClient(app)

    client.post(f"/api/projects/{pid}/preview")
    assert calls.acquire(timeout=10)
    for _ in range(100):
        if not jobs._preview_jobs[pid]["running"]:
            break
        threading.Event().wait(0.05)

    assert client.post(f"/api/projects/{pid}/preview").json() == {"message": "Preview render started"}
    assert calls.acquire(timeout=10)


def test_podcast_projects_have_no_proxy_preview(tmp_path, monkeypatch):
    pid = _video_project(tmp_path, monkeypatch)
    with storage.editing_project(pid) as proj:
        proj["project_type"] = "podcast"

    r = TestClient(app).post(f"/api/projects/{pid}/preview")
    assert r.status_code == 400

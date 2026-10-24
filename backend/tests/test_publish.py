"""DarkRelay bundles: edited-time transcripts and chapters, episode details, and the export job."""
import json
import shutil
import subprocess
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import jobs as jobs_api
from darkroom.api import projects as projects_api
from darkroom.api import publish as publish_api
from darkroom.services import publish
from darkroom.services.takes import probe_duration

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _seg(speaker, words):
    return {"speaker_id": speaker[0], "speaker_name": speaker, "start": words[0][1], "end": words[-1][2],
            "text": " ".join(w for w, _, _ in words),
            "words": [{"word": f" {w}", "start": s, "end": e} for w, s, e in words]}


def _project(**overrides):
    proj = {
        "id": "abcd1234",
        "project_type": "podcast",
        "edl": {"segments": [{"id": "s1", "start": 0, "end": 4, "keep": True, "camera": "A"},
                             {"id": "s2", "start": 4, "end": 6, "keep": False, "camera": "A"},
                             {"id": "s3", "start": 6, "end": 10, "keep": True, "camera": "B"}],
                "clips": []},
        "word_cuts": [{"start": 1.0, "end": 2.0}],
        "word_mutes": [],
        "merged_transcript": [
            _seg("Alice", [("Hello", 0.2, 0.6), ("um", 1.2, 1.5), ("there", 2.1, 2.5)]),
            _seg("Alice", [("cut", 4.5, 5.0)]),
            _seg("Bob", [("Hi", 6.5, 7.0), ("Alice", 7.1, 7.6)]),
        ],
        "publish": storage.default_publish(),
    }
    proj.update(overrides)
    return proj


def test_edited_words_skip_cuts_and_shift_times():
    words = publish.edited_words(_project())
    assert [w["text"] for w in words] == ["Hello", "there", "Hi", "Alice"]
    # Kept: 0–1, 2–4 (3 s), then 6–10 starts at 3 s in the edit
    assert words[1]["start"] == pytest.approx(1.1)
    assert words[2]["start"] == pytest.approx(3.5)
    assert words[2]["speaker"] == "Bob"


def test_muted_words_are_left_out():
    words = publish.edited_words(_project(word_mutes=[{"start": 7.0, "end": 7.7}]))
    assert "Alice" not in [w["text"] for w in words]


def test_cues_break_on_speaker_and_render_as_vtt():
    cues = publish._cues(publish.edited_words(_project()))
    assert [(c["speaker"], c["text"]) for c in cues] == [("Alice", "Hello there"), ("Bob", "Hi Alice")]
    vtt = publish.transcript_vtt(cues)
    assert vtt.startswith("WEBVTT\n\n00:00:00.200 --> 00:00:01.500\n<v Alice>Hello there\n")
    srt = publish.transcript_srt(cues)
    assert "2\n00:00:03,500 --> 00:00:04,600\nBob: Hi Alice\n" in srt
    assert publish.transcript_json(cues)["segments"][1] == \
        {"speaker": "Bob", "startTime": 3.5, "endTime": 4.6, "body": "Hi Alice"}


def test_chapters_follow_the_edit():
    proj = _project()
    proj["publish"]["chapters"] = [{"start": 6.5, "title": "Bob"}, {"start": 0, "title": "Intro"},
                                   {"start": 5.0, "title": "In a cut"}, {"start": 9.0, "title": " "}]
    chapters = publish.chapters_json(proj, duration=7.0)
    # "In a cut" moves to where the edit resumes (3.0); "Bob" lands at 3.5; blank titles are dropped
    assert chapters == {"version": "1.2.0", "chapters": [
        {"startTime": 0, "title": "Intro"}, {"startTime": 3.0, "title": "In a cut"},
        {"startTime": 3.5, "title": "Bob"}]}


def test_plain_notes_become_paragraphs():
    assert publish.notes_html("One & two\nthree\n\nFour") == "<p>One &amp; two<br>three</p>\n<p>Four</p>"
    assert publish.notes_html("<p>Already HTML</p>") == "<p>Already HTML</p>"


def test_validate_details():
    details = {**storage.default_publish(), "show": "My Show", "title": "", "notes": "",
               "pub_date": "2026-10-20T06:00", "yt_title": "a <b>"}
    errors = publish.validate_details(details)
    assert any(e.startswith("Show:") for e in errors)
    assert "Title is required" in errors
    assert "Release time needs a time zone" in errors
    assert any("< or >" in e for e in errors)
    ok = {**storage.default_publish(), "show": "my-show", "title": "Ep 1", "notes": "Notes",
          "pub_date": "2026-10-20T10:00:00Z"}
    assert publish.validate_details(ok) == []


def test_episode_json_leaves_out_empty_fields():
    details = {**storage.default_publish(), "show": "my-show", "guid": "g-1", "title": " Ep 1 ",
               "notes": "Notes", "season": 2, "yt_title": "Search title"}
    ep = publish.episode_json(details, 61.6, "en")
    assert ep == {"schemaVersion": 1, "show": "my-show", "guid": "g-1", "title": "Ep 1",
                  "description": "<p>Notes</p>", "durationSeconds": 62, "episodeType": "full",
                  "keywords": [], "season": 2, "transcriptLanguage": "en",
                  "youtube": {"title": "Search title"}}


def test_old_projects_get_publish_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    (tmp_path / "old00001").mkdir()
    (tmp_path / "old00001" / "project.json").write_text(json.dumps({"id": "old00001", "publish": {"show": "s"}}))
    proj = storage.get_project("old00001")
    assert proj["publish"]["show"] == "s"
    assert proj["publish"]["chapters"] == []


# ── Export job ────────────────────────────────────────────────────────────────

def _wav(path, seconds: float, freq: int) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}",
                    "-ac", "1", "-ar", "48000", str(path)], check=True)


def _png(path, size: int) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"color=c=red:s={size}x{size}",
                    "-frames:v", "1", str(path)], check=True)


@pytest.fixture
def client(tmp_path, monkeypatch):
    for module in (storage, projects_api, jobs_api, publish_api):
        monkeypatch.setattr(module, "PROJECTS_DIR", tmp_path)
    from darkroom.main import app
    return TestClient(app)


def _podcast(client, tmp_path):
    pid = client.post("/api/projects", json={"project_type": "podcast"}).json()["id"]
    with storage.editing_project(pid) as proj:
        speakers = []
        for sid, freq in (("A", 440), ("B", 660)):
            path = tmp_path / pid / f"cam_{sid}.wav"
            _wav(path, 10, freq)
            speakers.append({"id": sid, "name": sid, "file": path.name, "file_path": str(path)})
        sample = _project()
        proj.update(speakers=speakers, edl=sample["edl"], word_cuts=sample["word_cuts"],
                    merged_transcript=sample["merged_transcript"], status="ready", transcribe_language="en")
    return pid


def _wait_for_bundle(pid):
    for _ in range(300):
        proj = storage.get_project(pid)
        if proj["status"] == "ready" and proj["progress"]["step"] in ("done", "error"):
            return proj
        time.sleep(0.1)
    raise AssertionError("bundle did not finish")


@needs_ffmpeg
def test_bundle_export(client, tmp_path):
    pid = _podcast(client, tmp_path)
    assert client.post(f"/api/projects/{pid}/publish/bundle").status_code == 400  # no details yet

    details = {"show": "my-show", "title": "Episode 1", "notes": "First one.",
               "chapters": [{"start": 0, "title": "Intro"}, {"start": 6.5, "title": "Bob"}]}
    assert client.put(f"/api/projects/{pid}/publish", json=details).status_code == 200
    _png(tmp_path / "cover.png", 1400)
    with open(tmp_path / "cover.png", "rb") as f:
        r = client.post(f"/api/projects/{pid}/publish/cover", files={"file": ("cover.png", f, "image/png")})
    assert r.json()["publish"]["cover"] == "publish_cover.png"

    assert client.post(f"/api/projects/{pid}/publish/bundle").status_code == 200
    proj = _wait_for_bundle(pid)
    assert proj["progress"]["step"] == "done", proj["progress"]
    bundle = proj["publish"]["bundle"]
    assert bundle["files"] == ["audio.mp3", "chapters.json", "cover.png", "episode.json",
                               "transcript.json", "transcript.srt", "transcript.vtt"]
    assert bundle["warnings"] == []

    out = tmp_path / pid / "output" / "darkrelay"
    assert probe_duration(out / "audio.mp3") == pytest.approx(7.0, abs=0.15)
    episode = json.loads((out / "episode.json").read_text())
    assert episode["guid"] == proj["publish"]["guid"]
    assert episode["durationSeconds"] == 7
    assert json.loads((out / "chapters.json").read_text())["chapters"][1]["startTime"] == 3.5
    with zipfile.ZipFile(tmp_path / pid / "output" / "darkrelay.zip") as zf:
        assert f"{bundle['folder']}/episode.json" in zf.namelist()

    # Exporting again keeps the GUID, so DarkRelay updates the same episode
    guid = proj["publish"]["guid"]
    client.put(f"/api/projects/{pid}/publish", json={**details, "title": "Episode 1 (fixed)"})
    client.post(f"/api/projects/{pid}/publish/bundle")
    proj = _wait_for_bundle(pid)
    assert proj["publish"]["guid"] == guid
    assert json.loads((out / "episode.json").read_text())["title"] == "Episode 1 (fixed)"

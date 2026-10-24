"""
DarkRelay bundles meet DarkRelay's criteria (see bundle_criteria.py).

First the checker is shown to catch each kind of broken bundle, so a clean
result means something; then real exports, from awkward projects, come back clean.
Set DARKRELAY_DIR to a darkrelay checkout (after `npm install`) to also run the
bundles through DarkRelay's own code.
"""
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bundle_criteria import bundle_problems, check_episode, cover_recommendations
from darkroom import storage
from darkroom.api import jobs as jobs_api
from darkroom.api import projects as projects_api
from darkroom.api import publish as publish_api
from darkroom.services import publish
from test_publish import _png, _project, _seg, _wav

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _video(path, seconds: float) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=320x240:rate=30",
                    "-f", "lavfi", "-i", f"sine=duration={seconds}", "-shortest",
                    "-c:v", "libx264", "-c:a", "aac", str(path)], check=True)


def _details(**overrides) -> dict:
    return {**storage.default_publish(), "show": "my-show", "guid": publish.new_guid(), "title": "Episode 1",
            "notes": "Notes", **overrides}


def _export(tmp_path, project_type="podcast", cover_size=None, **overrides) -> tuple[Path, dict]:
    """Build a bundle from the sample project (10 s, a cut 4–6 s, a word cut 1–2 s)."""
    proj = _project(project_type=project_type, publish=_details(**overrides.pop("publish", {})), **overrides)
    pdir = tmp_path / proj["id"]
    pdir.mkdir(exist_ok=True)
    speakers = []
    for sid, freq in (("A", 440), ("B", 660)):
        path = pdir / (f"cam_{sid}.mp4" if project_type == "video" else f"cam_{sid}.wav")
        _video(path, 10) if project_type == "video" else _wav(path, 10, freq)
        speakers.append({"id": sid, "name": sid, "file": path.name, "file_path": str(path)})
    proj["speakers"] = speakers
    if cover_size:
        _png(pdir / "publish_cover.png", cover_size)
        proj["publish"]["cover"] = "publish_cover.png"
    summary = publish.build_bundle(proj, tmp_path)
    return Path(summary["dir"]), summary


@pytest.fixture(scope="module")
def good_bundle(tmp_path_factory):
    """A complete podcast bundle; checker tests copy it and break one thing."""
    tmp = tmp_path_factory.mktemp("good")
    bundle, _ = _export(tmp, cover_size=1400, publish={
        "season": 2, "episode": 5, "explicit": False, "keywords": ["tech"],
        "pub_date": "2026-11-01T10:00:00+00:00", "yt_title": "Search title", "yt_description": "Plain text",
        "chapters": [{"start": 0, "title": "Intro"}, {"start": 6.5, "title": "Bob"}]})
    return bundle


# ── The checker catches each kind of problem ─────────────────────────────────

def test_good_bundle_passes(good_bundle):
    assert bundle_problems(good_bundle) == []


def _edit_json(path: Path, change) -> None:
    data = json.loads(path.read_text())
    change(data)
    path.write_text(json.dumps(data))


def _replace_cover_with_jpeg_named_png(b: Path) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-f", "lavfi", "-i", "color=s=1400x1400", "-frames:v", "1",
                    "-f", "mjpeg", str(b / "cover.png")], check=True)


BREAKAGES = {
    "unknown file": (lambda b: (b / "notes.txt").write_text("x"), "DarkRelay ignores"),
    "WAV audio": (lambda b: (b / "audio.mp3").rename(b / "audio.wav"), "ignores this file"),
    "no media": (lambda b: (b / "audio.mp3").unlink(), "No audio or video"),
    "not really an MP3": (lambda b: subprocess.run(
        ["ffmpeg", "-v", "quiet", "-y", "-f", "lavfi", "-i", "sine=duration=7", "-f", "wav", str(b / "audio.mp3")],
        check=True), "expected one MP3"),
    "bad slug": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(show="My Show")), "slug"),
    "empty title": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(title="")), "title"),
    "pubDate without offset": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(pubDate="2026-11-01T10:00")),
                               "pubDate"),
    "compact pubDate": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(pubDate="20261101T1000Z")),
                        "pubDate"),
    "fractional duration": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(durationSeconds=7.2)),
                            "durationSeconds"),
    "wrong duration": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(durationSeconds=60)),
                       "but the audio is"),
    "unknown field": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(seasonNumber=2)), "unknown fields"),
    "season as text": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(season="2")), "season"),
    "long YouTube title": (lambda b: _edit_json(b / "episode.json", lambda d: d.update(youtube={"title": "x" * 101})),
                           "youtube.title"),
    "angle brackets for YouTube": (lambda b: _edit_json(b / "episode.json",
                                                        lambda d: d.update(youtube={"description": "a <b>"})), "< or >"),
    "VTT header": (lambda b: (b / "transcript.vtt").write_text((b / "transcript.vtt").read_text()[6:]), "WEBVTT"),
    "VTT markup": (lambda b: (b / "transcript.vtt").write_text(
        (b / "transcript.vtt").read_text().replace("Hello", "a<b")), "unescaped markup"),
    "cue past the end": (lambda b: (b / "transcript.vtt").write_text(
        (b / "transcript.vtt").read_text().replace("00:00:04.600", "00:00:09.000")), "after the audio"),
    "formats disagree": (lambda b: (b / "transcript.srt").write_text(
        (b / "transcript.srt").read_text().replace("00:00:04,600", "00:00:04,500")), "disagree"),
    "SRT numbering": (lambda b: (b / "transcript.srt").write_text(
        (b / "transcript.srt").read_text().replace("2\n00:", "3\n00:")), "numbered"),
    "zero-length cue": (lambda b: _edit_json(b / "transcript.json",
                                             lambda d: d["segments"][0].update(endTime=d["segments"][0]["startTime"])),
                        "ends at or before"),
    "chapters out of order": (lambda b: _edit_json(b / "chapters.json", lambda d: d["chapters"].reverse()),
                              "startTime order"),
    "chapter after the end": (lambda b: _edit_json(b / "chapters.json",
                                                   lambda d: d["chapters"].append({"startTime": 60, "title": "x"})),
                              "after the audio ends"),
    "no chapters": (lambda b: _edit_json(b / "chapters.json", lambda d: d.update(chapters=[])), "at least one"),
    "cover not what it says": (_replace_cover_with_jpeg_named_png, "is not a PNG"),
}


@pytest.mark.parametrize("name", BREAKAGES)
def test_checker_catches(name, good_bundle, tmp_path):
    bundle = tmp_path / "bundle"
    shutil.copytree(good_bundle, bundle)
    breakage, expected = BREAKAGES[name]
    breakage(bundle)
    problems = bundle_problems(bundle)
    assert any(expected in p for p in problems), problems


# ── Exports meet the criteria ────────────────────────────────────────────────

def test_podcast_bundle_meets_criteria(good_bundle):
    names = sorted(f.name for f in good_bundle.iterdir())
    assert names == ["audio.mp3", "chapters.json", "cover.png", "episode.json",
                     "transcript.json", "transcript.srt", "transcript.vtt"]
    assert bundle_problems(good_bundle) == []
    assert cover_recommendations(good_bundle / "cover.png") == []


def test_video_bundle_meets_criteria(tmp_path):
    bundle, _ = _export(tmp_path, project_type="video")
    assert "video.mp4" in {f.name for f in bundle.iterdir()}
    assert bundle_problems(bundle) == []


def test_video_can_be_left_out(tmp_path):
    bundle, _ = _export(tmp_path, project_type="video", publish={"include_video": False})
    assert "video.mp4" not in {f.name for f in bundle.iterdir()}
    assert bundle_problems(bundle) == []


def test_awkward_transcript_meets_criteria(tmp_path):
    """Markup characters, a word cut on both sides, a zero-length word, crosstalk, mutes, a trailing word."""
    transcript = [
        _seg("Alice", [("a<b", 0.1, 0.4), ("&", 0.5, 0.6), ("-->", 0.6, 0.7), ("straddles", 0.9, 2.1)]),
        _seg("Bob", [("over", 0.3, 0.8), ("blink", 3.0, 3.0)]),
        _seg("Alice", [("muted", 7.0, 7.5), ("last", 9.6, 10.0)]),
    ]
    bundle, _ = _export(tmp_path, merged_transcript=transcript, word_cuts=[{"start": 0.85, "end": 0.95},
                                                                           {"start": 2.0, "end": 2.2}],
                        word_mutes=[{"start": 6.9, "end": 7.6}])
    assert bundle_problems(bundle) == []
    vtt = (bundle / "transcript.vtt").read_text()
    assert "a&lt;b" in vtt and "&amp;" in vtt and "--&gt;" in vtt
    assert "muted" not in vtt


def test_chapters_in_cuts_meet_criteria(tmp_path):
    """Chapters inside cuts, on the same moment, past the end and untitled still give valid chapters."""
    chapters = [{"start": 4.5, "title": "In the cut"}, {"start": 5.5, "title": "Same place"},
                {"start": 1.5, "title": "In a word cut"}, {"start": 0, "title": "Intro"},
                {"start": 30, "title": "Past the end"}, {"start": 8, "title": "  "}]
    bundle, summary = _export(tmp_path, publish={"chapters": chapters})
    assert bundle_problems(bundle) == []
    titles = [c["title"] for c in json.loads((bundle / "chapters.json").read_text())["chapters"]]
    assert titles == ["Intro", "In a word cut", "Same place"]
    assert summary["warnings"] == []


def test_nothing_left_to_transcribe(tmp_path):
    """If every word is cut the bundle has no transcripts, says so, and is still valid."""
    bundle, summary = _export(tmp_path, word_mutes=[{"start": 0, "end": 10}])
    assert not any(f.name.startswith("transcript.") for f in bundle.iterdir())
    assert any("no transcript" in w for w in summary["warnings"])
    assert bundle_problems(bundle) == []


@pytest.mark.parametrize("pub_date", ["2026-11-01T10:00:00Z", "2026-11-01T10:00:00.000Z",
                                      "2026-11-01T06:00-04:00", "2026-11-01 10:00+00:00", "20261101T1000Z"])
def test_release_times_are_written_as_darkrelay_reads_them(pub_date):
    """Python reads more ISO forms than DarkRelay does; episode.json gets one DarkRelay accepts."""
    assert publish.validate_details(_details(pub_date=pub_date)) == []
    ep = publish.episode_json(_details(pub_date=pub_date), 60, None)
    assert check_episode(ep) == []


def test_youtube_copy_at_the_limits():
    title, desc = "t" * 100, "é" * 2500  # 5000 bytes
    ep = publish.episode_json(_details(yt_title=title, yt_description=desc), 60, "en")
    assert check_episode(ep) == []
    assert publish.validate_details(_details(yt_title=title + "t")) != []
    assert publish.validate_details(_details(yt_description=desc + "e")) != []


@pytest.mark.parametrize("size,warning", [(1400, None), (3000, None), (1000, "1400 to 3000"), ((1600, 1400), "square")])
def test_cover_size_warnings(tmp_path, size, warning):
    pdir = tmp_path / "abcd1234"
    pdir.mkdir()
    w, h = size if isinstance(size, tuple) else (size, size)
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"color=c=red:s={w}x{h}", "-frames:v", "1",
                    str(pdir / "publish_cover.png")], check=True)
    proj = _project(publish=_details(cover="publish_cover.png"))
    wav = pdir / "cam_A.wav"
    _wav(wav, 10, 440)
    proj["speakers"] = [{"id": "A", "name": "A", "file": wav.name, "file_path": str(wav)}]
    summary = publish.build_bundle(proj, tmp_path)
    cover_warnings = [x for x in summary["warnings"] if "Cover" in x]
    assert (warning in cover_warnings[0]) if warning else cover_warnings == []
    assert bundle_problems(Path(summary["dir"])) == []


def test_zip_holds_exactly_the_bundle(good_bundle):
    zip_path = good_bundle.parent / publish.BUNDLE_ZIP
    with zipfile.ZipFile(zip_path) as zf:
        folders = {n.split("/")[0] for n in zf.namelist()}
        assert len(folders) == 1
        folder = folders.pop()
        assert sorted(zf.namelist()) == sorted(f"{folder}/{f.name}" for f in good_bundle.iterdir())
        for f in good_bundle.iterdir():
            assert zf.read(f"{folder}/{f.name}") == f.read_bytes()


# ── Cover upload ─────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    for module in (storage, projects_api, jobs_api, publish_api):
        monkeypatch.setattr(module, "PROJECTS_DIR", tmp_path)
    from darkroom.main import app
    return TestClient(app)


def test_cover_is_named_by_its_content(client, tmp_path):
    """A browser can label a PNG as image/jpeg; the file must still be cover.png."""
    pid = client.post("/api/projects", json={"project_type": "podcast"}).json()["id"]
    _png(tmp_path / "art.png", 1400)
    with open(tmp_path / "art.png", "rb") as f:
        r = client.post(f"/api/projects/{pid}/publish/cover", files={"file": ("art.jpg", f, "image/jpeg")})
    assert r.json()["publish"]["cover"] == "publish_cover.png"

    r = client.post(f"/api/projects/{pid}/publish/cover", files={"file": ("art.png", b"GIF89a....", "image/png")})
    assert r.status_code == 400


# ── DarkRelay's own code ─────────────────────────────────────────────────────

_DARKRELAY = os.getenv("DARKRELAY_DIR")


@pytest.mark.skipif(not (_DARKRELAY and (Path(_DARKRELAY) / "node_modules" / ".bin" / "tsx").exists()),
                    reason="set DARKRELAY_DIR to a darkrelay checkout with node_modules")
def test_darkrelay_accepts_bundles(good_bundle, tmp_path):
    video_bundle, _ = _export(tmp_path, project_type="video")
    script = Path(__file__).parent / "darkrelay_check.mts"
    for bundle in (good_bundle, video_bundle):
        out = subprocess.run([str(Path(_DARKRELAY) / "node_modules" / ".bin" / "tsx"), str(script),
                              _DARKRELAY, str(bundle)], capture_output=True, text=True, cwd=_DARKRELAY)
        assert out.returncode == 0, out.stderr + out.stdout

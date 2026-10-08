"""Inline transcript corrections keep word timings so cuts still line up."""
import pytest
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import media
from darkroom.main import app


def _words(*spec):
    return [{"word": " " + w, "start": s, "end": e} for w, s, e in spec]


def test_same_count_keeps_each_words_times():
    words = _words(("the", 0.0, 0.2), ("teen", 0.3, 0.6), ("channel", 0.7, 1.2))
    out = media._replace_words(words, 1, 1, "team")
    assert out[1] == {"word": " team", "start": 0.3, "end": 0.6}
    assert out[0] == words[0] and out[2] == words[2]


def test_different_count_shares_the_span():
    words = _words(("a", 0.0, 0.1), ("teen", 1.0, 2.0), ("b", 3.0, 3.1))
    out = media._replace_words(words, 1, 1, "Tim's own")
    assert [w["word"] for w in out] == [" a", " Tim's", " own", " b"]
    assert out[1]["start"] == 1.0 and out[2]["end"] == 2.0
    assert out[1]["end"] == pytest.approx(out[2]["start"])


def test_empty_text_removes_words():
    words = _words(("uh", 0.0, 0.1), ("hi", 0.2, 0.4))
    assert media._replace_words(words, 0, 0, "  ") == words[1:]


def test_endpoint_updates_segment(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    proj["merged_transcript"] = [{
        "speaker_id": "A", "speaker_name": "Joanne", "start": 0.0, "end": 1.2,
        "text": "You ask the teen channel.",
        "words": _words(("You", 0.0, 0.1), ("ask", 0.1, 0.2), ("the", 0.2, 0.3),
                        ("teen", 0.3, 0.6), ("channel.", 0.7, 1.2)),
    }]
    storage.save_project(proj)

    client = TestClient(app)
    r = client.patch(f"/api/projects/{proj['id']}/transcript/0/words",
                     json={"first": 3, "last": 3, "text": "team"})
    assert r.status_code == 200
    seg = storage.get_project(proj["id"])["merged_transcript"][0]
    assert seg["text"] == "You ask the team channel."
    assert seg["words"][3]["start"] == 0.3

    r = client.patch(f"/api/projects/{proj['id']}/transcript/0/words",
                     json={"first": 3, "last": 9, "text": "x"})
    assert r.status_code == 400

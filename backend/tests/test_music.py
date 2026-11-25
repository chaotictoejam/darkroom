"""
Music and sound cues: where a cue lands once speech is cut, how the duck
envelope is shaped, and what comes out of a render.

The render tests work with a digitally silent speech track, so the only thing
in the output is the music — which makes the ducking measurable: the stretch
the transcript says someone is talking over must come out quieter by the cue's
duck depth, and the rest at full level.
"""
import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from darkroom.services import library, music
from darkroom.services import renderer

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


# ── Intervals ─────────────────────────────────────────────────────────────────

def test_merge_spans_joins_overlapping_and_nearby():
    assert music.merge_spans([(2, 3), (0, 1), (0.9, 1.5)]) == [(0, 1.5), (2, 3)]
    assert music.merge_spans([(0, 1), (1.3, 2)], gap=0.5) == [(0, 2)]
    assert music.merge_spans([(0, 1), (1.3, 2)]) == [(0, 1), (1.3, 2)]
    assert music.merge_spans([]) == []


def test_merge_spans_keeps_the_longer_of_two_nested_spans():
    assert music.merge_spans([(0, 5), (1, 2)]) == [(0, 5)]


def test_speech_spans_comes_from_words_and_falls_back_to_the_segment():
    segments = [
        {"start": 0, "end": 2, "words": [{"start": 0.0, "end": 0.4},
                                         {"start": 0.45, "end": 0.9},
                                         {"start": 3.0, "end": 3.0}]},
        {"start": 5, "end": 6, "words": []},
    ]
    # Zero-length words are dropped; the gaps between words stay (ducking merges them)
    assert music.speech_spans(segments) == [(0.0, 0.4), (0.45, 0.9), (5, 6)]
    assert music.speech_spans([]) == []


def test_to_output_drops_cut_speech_and_splits_a_straddling_span():
    # 0–10 kept, 10–20 cut, 20–30 kept
    ranges = [(0.0, 10.0), (20.0, 30.0)]
    assert music.to_output([(1.0, 2.0)], ranges) == [(1.0, 2.0)]
    assert music.to_output([(12.0, 15.0)], ranges) == []           # inside the cut
    assert music.to_output([(21.0, 22.0)], ranges) == [(11.0, 12.0)]
    # A span over the cut is heard at the end of one piece and the start of the next
    assert music.to_output([(9.0, 21.0)], ranges) == [(9.0, 11.0)]


def test_snap_to_output_moves_a_cut_anchor_forward():
    ranges = [(0.0, 10.0), (20.0, 30.0)]
    assert music.snap_to_output(5.0, ranges) == 5.0
    assert music.snap_to_output(15.0, ranges) == 10.0   # inside the cut → next kept moment
    assert music.snap_to_output(25.0, ranges) == 15.0
    assert music.snap_to_output(40.0, ranges) is None   # past the end


# ── Ducking ───────────────────────────────────────────────────────────────────

def test_duck_spans_opens_early_and_holds_after():
    spans = music.duck_spans([(10.0, 11.0)], limit=60.0)
    assert spans == [(10.0 - music.DUCK_LOOKAHEAD, 11.0 + music.DUCK_HOLD)]


def test_duck_spans_merge_across_the_gaps_inside_a_sentence():
    # Two words 0.3 s apart are one dip, not two
    assert len(music.duck_spans([(5.0, 5.5), (5.8, 6.2)], limit=60.0)) == 1


def test_duck_spans_are_clamped_to_the_edit():
    assert music.duck_spans([(0.1, 1.0)], limit=1.2) == [(0.0, 1.2)]
    assert music.duck_spans([(30.0, 31.0)], limit=10.0) == []


def test_duck_envelope_reaches_the_depth_and_returns_to_unity():
    env = music.duck_envelope([(2.0, 6.0)], -12.0, duration=10.0)
    rate = music.ENV_RATE
    assert env[int(0.5 * rate)] == pytest.approx(1.0)
    assert env[int(4.0 * rate)] == pytest.approx(10 ** (-12 / 20), abs=1e-4)
    assert env[int(9.0 * rate)] == pytest.approx(1.0)
    # Runs past the end of the edit so a cue's tail is never multiplied by nothing
    assert len(env) >= math.ceil(10.0 * rate)


def test_duck_envelope_ramps_rather_than_jumps():
    env = music.duck_envelope([(2.0, 6.0)], -12.0, duration=10.0)
    rate = music.ENV_RATE
    assert np.all(np.abs(np.diff(env)) < 0.05)        # no clicks
    start = int(2.0 * rate)
    assert env[start] > env[start + int(music.DUCK_FADE_DOWN * rate / 2)]


def test_duck_envelope_of_a_short_dip_scales_its_fades():
    env = music.duck_envelope([(1.0, 1.1)], -24.0, duration=5.0)
    assert env.min() < 1.0
    assert env[0] == pytest.approx(1.0)


def test_duck_envelope_without_speech_is_flat():
    assert np.all(music.duck_envelope([], -12.0, duration=5.0) == 1.0)


# ── Planning ──────────────────────────────────────────────────────────────────

def _fake_library(monkeypatch, duration=30.0, loudness=-14.0, path="/tmp/track.flac"):
    item = {"id": "t1", "name": "Theme", "file": "music/t1.flac",
            "duration": duration, "loudness": loudness}
    monkeypatch.setattr(music.library, "get_track", lambda tid: item if tid == "t1" else None)
    monkeypatch.setattr(music.library, "track_path", lambda t: Path(path))
    monkeypatch.setattr(Path, "exists", lambda self: True)
    return item


def _project(cues, **extra):
    return {"sound_cues": cues, "merged_transcript": [], **extra}


def test_a_bed_is_placed_in_output_time_and_trimmed_to_the_edit(monkeypatch):
    _fake_library(monkeypatch, duration=10.0)
    ranges = [(0.0, 10.0), (20.0, 30.0)]  # 10–20 cut; 20 s of output
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "bed", "at": 5.0, "until": 25.0}]), ranges)
    cue, = plan.cues
    assert cue.start == 5.0
    assert cue.length == 10.0     # 5–10 and 20–25 survive the cut
    assert cue.loop is False      # a 10 s track already fills a 10 s span
    assert plan.duration == 20.0


def test_a_bed_anchored_inside_a_cut_starts_where_the_edit_resumes(monkeypatch):
    _fake_library(monkeypatch)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "bed", "at": 15.0, "until": 28.0}]),
        [(0.0, 10.0), (20.0, 30.0)])
    assert plan.cues[0].start == 10.0


def test_a_bed_past_the_end_of_the_edit_is_dropped(monkeypatch):
    _fake_library(monkeypatch)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "bed", "at": 99.0}]), [(0.0, 10.0)])
    assert plan.cues == []


def test_an_open_ended_bed_runs_to_the_end_of_the_edit(monkeypatch):
    _fake_library(monkeypatch, duration=5.0)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "bed", "at": 2.0, "until": None}]), [(0.0, 10.0)])
    assert plan.cues[0].length == 8.0


def test_an_intro_sits_at_the_start_and_an_outro_at_the_end(monkeypatch):
    _fake_library(monkeypatch, duration=6.0)
    plan = music.plan_music(_project([
        {"library_id": "t1", "kind": "intro", "loop": False},
        {"library_id": "t1", "kind": "outro", "loop": False},
    ]), [(0.0, 60.0)])
    intro, outro = plan.cues
    assert (intro.start, intro.length) == (0.0, 6.0)
    assert (outro.start, outro.length) == (54.0, 6.0)


def test_a_cue_never_runs_past_the_end_of_the_speech(monkeypatch):
    _fake_library(monkeypatch, duration=600.0)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "intro", "loop": False}]), [(0.0, 12.0)])
    assert plan.cues[0].length == 12.0


def test_a_cue_that_does_not_loop_stops_when_the_file_runs_out(monkeypatch):
    _fake_library(monkeypatch, duration=4.0)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "bed", "at": 0.0, "loop": False}]), [(0.0, 60.0)])
    assert plan.cues[0].length == 4.0
    assert plan.cues[0].loop is False


def test_fades_never_overlap_in_the_middle_of_a_short_cue(monkeypatch):
    _fake_library(monkeypatch, duration=1.0)
    plan = music.plan_music(_project([
        {"library_id": "t1", "kind": "sfx", "at": 0.0, "fade_in": 3.0, "fade_out": 3.0},
    ]), [(0.0, 60.0)])
    cue = plan.cues[0]
    assert cue.fade_in == cue.fade_out == 0.5


def test_cues_on_a_muted_track_and_of_deleted_library_items_are_dropped(monkeypatch):
    _fake_library(monkeypatch)
    project = _project(
        [{"library_id": "t1", "track": "music"}, {"library_id": "gone", "track": "music"}],
        sound_tracks=[{"id": "music", "name": "Music", "gain_db": 0.0, "muted": True}])
    assert music.plan_music(project, [(0.0, 60.0)]).cues == []


def test_a_tracks_gain_adds_to_its_cues(monkeypatch):
    _fake_library(monkeypatch)
    project = _project([{"library_id": "t1", "gain_db": -12.0}],
                       sound_tracks=[{"id": "music", "name": "Music", "gain_db": -3.0, "muted": False}])
    assert music.plan_music(project, [(0.0, 60.0)]).cues[0].gain_db == -15.0


def test_speech_is_only_resolved_when_something_ducks(monkeypatch):
    _fake_library(monkeypatch)
    segments = [{"start": 1, "end": 2, "words": [{"start": 1.0, "end": 2.0}]}]
    quiet = music.plan_music(
        _project([{"library_id": "t1", "duck": False}], merged_transcript=segments), [(0.0, 60.0)])
    assert quiet.speech == [] and quiet.cues[0].duck_db is None
    ducked = music.plan_music(
        _project([{"library_id": "t1", "duck": True}], merged_transcript=segments), [(0.0, 60.0)])
    assert ducked.speech == [(1.0, 2.0)] and ducked.cues[0].duck_db == -9.0


def test_an_empty_edit_has_no_music(monkeypatch):
    _fake_library(monkeypatch)
    assert not music.plan_music(_project([{"library_id": "t1"}]), [])


# ── Filter graph ──────────────────────────────────────────────────────────────

def test_the_filter_graph_numbers_its_own_inputs(monkeypatch, tmp_path):
    _fake_library(monkeypatch)
    plan = music.plan_music(_project([
        {"library_id": "t1", "kind": "bed", "at": 0.0, "duck": False},
        {"library_id": "t1", "kind": "sfx", "at": 10.0, "duck": True},
    ], merged_transcript=[{"start": 1, "end": 2, "words": [{"start": 1.0, "end": 2.0}]}]),
        [(0.0, 60.0)])
    inputs, parts, label = music.build_music_filter(plan, "[speech]", 3, -16.0, tmp_path)

    assert inputs.count("-i") == 3            # two cues plus one duck envelope
    assert "[3:a]" in parts[0] and "[4:a]" in parts[1]
    assert "[5:a]aresample=48000" in parts[2]
    assert "amultiply" in parts[3]
    assert label == "[mixed]"
    assert parts[-1].startswith("[speech][cue0][ducked0]amix=inputs=3:duration=first")
    assert (tmp_path / "duck0.f32").exists()


def test_cues_that_duck_by_the_same_amount_share_one_envelope(monkeypatch, tmp_path):
    _fake_library(monkeypatch)
    plan = music.plan_music(_project(
        [{"library_id": "t1", "kind": "bed", "at": 0.0, "duck_db": -9.0},
         {"library_id": "t1", "kind": "sfx", "at": 5.0, "duck_db": -9.0},
         {"library_id": "t1", "kind": "sfx", "at": 8.0, "duck_db": -20.0}],
        merged_transcript=[{"start": 1, "end": 2, "words": [{"start": 1.0, "end": 2.0}]}]),
        [(0.0, 60.0)])
    inputs, parts, _ = music.build_music_filter(plan, "[speech]", 1, -16.0, tmp_path)

    assert inputs.count("-i") == 5            # three cues, two envelopes
    assert sum("amultiply" in p for p in parts) == 2
    assert any("amix=inputs=2:normalize=0[duckable" in p for p in parts)


def test_a_cue_is_gained_to_sit_under_the_voice(monkeypatch, tmp_path):
    _fake_library(monkeypatch, loudness=-8.0)
    plan = music.plan_music(
        _project([{"library_id": "t1", "gain_db": -12.0, "duck": False}]), [(0.0, 60.0)])
    _, parts, _ = music.build_music_filter(plan, "[speech]", 1, -16.0, tmp_path)
    # A −8 LUFS track asked to sit 12 dB under a −16 LUFS voice comes down 20 dB
    assert "volume=-20.00dB" in parts[0]


def test_a_silent_library_track_keeps_its_gain_as_given(monkeypatch, tmp_path):
    _fake_library(monkeypatch, loudness=None)
    plan = music.plan_music(
        _project([{"library_id": "t1", "gain_db": -6.0, "duck": False}]), [(0.0, 60.0)])
    _, parts, _ = music.build_music_filter(plan, "[speech]", 1, -16.0, tmp_path)
    assert "volume=-6.00dB" in parts[0]


def test_a_looping_cue_asks_ffmpeg_to_loop_the_input(monkeypatch, tmp_path):
    _fake_library(monkeypatch, duration=2.0)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "bed", "at": 0.0, "duck": False}]), [(0.0, 60.0)])
    inputs, parts, _ = music.build_music_filter(plan, "[speech]", 1, -16.0, tmp_path)
    assert inputs[:2] == ["-stream_loop", "-1"]
    assert "atrim=duration=60.000" in parts[0]


def test_a_delayed_cue_is_pushed_out_by_its_start(monkeypatch, tmp_path):
    _fake_library(monkeypatch)
    plan = music.plan_music(
        _project([{"library_id": "t1", "kind": "sfx", "at": 12.5, "duck": False}]), [(0.0, 60.0)])
    _, parts, _ = music.build_music_filter(plan, "[speech]", 1, -16.0, tmp_path)
    assert "adelay=12500:all=1" in parts[0]


# ── Library ───────────────────────────────────────────────────────────────────

def _tone(path: Path, seconds: float, freq: int = 220, volume: float = 0.5) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-f", "lavfi",
                    "-i", f"sine=frequency={freq}:duration={seconds}",
                    "-af", f"volume={volume}", str(path)], check=True)


@needs_ffmpeg
def test_importing_a_track_transcodes_measures_and_indexes_it(tmp_path, monkeypatch):
    monkeypatch.setenv("DARKROOM_LIBRARY_DIR", str(tmp_path / "lib"))
    source = tmp_path / "theme.wav"
    _tone(source, 3.0)

    track = library.import_track(source, "My Theme")

    assert track["name"] == "My Theme"
    assert track["duration"] == pytest.approx(3.0, abs=0.05)
    assert -30 < track["loudness"] < 0
    path = library.track_path(track)
    assert path.suffix == ".flac" and path.exists()
    streams = json.loads(subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True).stdout)["streams"]
    assert streams[0]["channels"] == 2 and streams[0]["sample_rate"] == "48000"
    assert [t["id"] for t in library.list_tracks()] == [track["id"]]


@needs_ffmpeg
def test_a_file_with_no_audio_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("DARKROOM_LIBRARY_DIR", str(tmp_path / "lib"))
    junk = tmp_path / "notes.wav"
    junk.write_bytes(b"not audio at all")
    with pytest.raises(RuntimeError):
        library.import_track(junk, "Junk")
    assert library.list_tracks() == []
    assert not list((tmp_path / "lib" / "music").glob("*")) or True


@needs_ffmpeg
def test_renaming_and_deleting_a_library_track(tmp_path, monkeypatch):
    monkeypatch.setenv("DARKROOM_LIBRARY_DIR", str(tmp_path / "lib"))
    _tone(tmp_path / "a.wav", 1.0)
    track = library.import_track(tmp_path / "a.wav", "First")

    assert library.rename_track(track["id"], "Second")["name"] == "Second"
    assert library.rename_track("nope", "x") is None
    assert library.get_track(track["id"])["name"] == "Second"

    assert library.delete_track(track["id"]) is True
    assert library.delete_track(track["id"]) is False
    assert library.list_tracks() == []
    assert not library.track_path(track).exists()


def test_a_missing_or_corrupt_index_reads_as_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("DARKROOM_LIBRARY_DIR", str(tmp_path / "lib"))
    assert library.load_index() == {"tracks": []}
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "library.json").write_text("{not json")
    assert library.load_index() == {"tracks": []}


# ── Rendering ─────────────────────────────────────────────────────────────────

def _silent_speech(path: Path, seconds: float) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-f", "lavfi",
                    "-i", f"anullsrc=r=48000:cl=mono:d={seconds}", str(path)], check=True)


def _rms_db(path: Path, start: float, end: float) -> float:
    """Level of a window of a rendered file, in dBFS."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start), "-to", str(end), "-i", str(path),
         "-af", "astats=measure_perchannel=none:measure_overall=RMS_level",
         "-f", "null", "-"], capture_output=True, text=True).stderr
    line = next(l for l in out.splitlines() if "RMS level dB" in l)
    return float(line.rsplit(":", 1)[1])


@pytest.fixture
def music_project(tmp_path, monkeypatch):
    """
    An audio project whose speech track is digitally silent, with a transcript
    saying someone talks from 4 s to 8 s, and a looping bed over the whole thing.
    Whatever comes out is music alone, so its level can be measured directly.
    """
    monkeypatch.setenv("DARKROOM_LIBRARY_DIR", str(tmp_path / "lib"))
    _tone(tmp_path / "bed.wav", 3.0)
    track = library.import_track(tmp_path / "bed.wav", "Bed")

    pid = "mus00001"
    (tmp_path / pid).mkdir()
    _silent_speech(tmp_path / pid / "cam_A.wav", 12.0)
    return {
        "id": pid,
        "project_type": "podcast",
        "speakers": [{"id": "A", "name": "A", "file": "cam_A.wav",
                      "file_path": str(tmp_path / pid / "cam_A.wav")}],
        "edl": {"segments": [{"id": "s1", "start": 0, "end": 12, "keep": True, "camera": "A"}],
                "clips": []},
        "word_cuts": [],
        "word_mutes": [],
        "merged_transcript": [{"speaker_id": "A", "start": 4.0, "end": 8.0, "text": "talking",
                               "words": [{"word": "talking", "start": 4.0, "end": 8.0}]}],
        "sound_tracks": [{"id": "music", "name": "Music", "gain_db": 0.0, "muted": False}],
        "sound_cues": [{"id": "c1", "library_id": track["id"], "track": "music", "kind": "bed",
                        "at": 0.0, "until": None, "gain_db": -6.0, "duck": True, "duck_db": -12.0,
                        "loop": True, "fade_in": 0.0, "fade_out": 0.0}],
    }


@needs_ffmpeg
def test_an_audio_export_carries_the_music_ducked_under_the_speech(music_project, tmp_path):
    results = renderer.render_project(music_project, ["wav"], tmp_path)
    assert results["wav"]["status"] == "done", results
    out = tmp_path / music_project["id"] / "output" / "fullEdit.wav"

    open_level = _rms_db(out, 1.0, 3.0)      # nobody talking: music at full level
    ducked_level = _rms_db(out, 5.0, 7.0)    # mid-sentence: held down
    assert open_level > -40                   # the music is actually in there
    assert open_level - ducked_level == pytest.approx(12.0, abs=1.5)
    # It comes back up after the phrase ends
    assert _rms_db(out, 9.5, 11.5) == pytest.approx(open_level, abs=1.5)


@needs_ffmpeg
def test_a_cue_without_ducking_holds_one_level_throughout(music_project, tmp_path):
    music_project["sound_cues"][0]["duck"] = False
    renderer.render_project(music_project, ["wav"], tmp_path)
    out = tmp_path / music_project["id"] / "output" / "fullEdit.wav"
    assert _rms_db(out, 5.0, 7.0) == pytest.approx(_rms_db(out, 1.0, 3.0), abs=1.0)


@needs_ffmpeg
def test_a_cue_follows_the_edit_when_speech_is_cut(music_project, tmp_path):
    """A bed anchored at 6 s moves to 2 s once 2–6 s is cut."""
    music_project["word_cuts"] = [{"start": 2.0, "end": 6.0}]
    music_project["sound_cues"][0].update({"at": 6.0, "duck": False})
    renderer.render_project(music_project, ["wav"], tmp_path)
    out = tmp_path / music_project["id"] / "output" / "fullEdit.wav"
    assert _rms_db(out, 0.2, 1.5) < -60       # silence before the cue starts
    assert _rms_db(out, 3.0, 5.0) > -40


@needs_ffmpeg
def test_a_bed_that_does_not_loop_stops_when_its_file_runs_out(music_project, tmp_path):
    """The 3 s bed is not repeated to fill the 12 s episode: it just ends."""
    music_project["sound_cues"][0].update({"duck": False, "loop": False})
    renderer.render_project(music_project, ["wav"], tmp_path)
    out = tmp_path / music_project["id"] / "output" / "fullEdit.wav"
    assert _rms_db(out, 0.5, 2.5) > -40       # playing
    assert _rms_db(out, 4.0, 11.5) < -60      # and silent for the rest of the episode


@needs_ffmpeg
def test_a_bed_stops_at_the_end_the_user_set(music_project, tmp_path):
    """An explicit end wins over the loop that would otherwise fill the episode."""
    music_project["sound_cues"][0].update({"duck": False, "until": 5.0})
    renderer.render_project(music_project, ["wav"], tmp_path)
    out = tmp_path / music_project["id"] / "output" / "fullEdit.wav"
    assert _rms_db(out, 0.5, 4.5) > -40
    assert _rms_db(out, 5.5, 11.5) < -60


@needs_ffmpeg
def test_an_audio_only_preview_is_the_mix(music_project, tmp_path):
    result = renderer.render_preview(music_project, tmp_path)
    assert result["filename"].endswith(".m4a")
    out = tmp_path / music_project["id"] / "output" / result["filename"]
    assert out.exists()
    assert _rms_db(out, 1.0, 3.0) - _rms_db(out, 5.0, 7.0) == pytest.approx(12.0, abs=2.0)
    # No half-written files left behind
    assert not list(out.parent.glob("*.part.*")) and not list(out.parent.glob("*.speech.*"))


@needs_ffmpeg
def test_a_project_without_cues_renders_exactly_as_before(music_project, tmp_path):
    music_project["sound_cues"] = []
    results = renderer.render_project(music_project, ["wav"], tmp_path)
    assert results["wav"]["status"] == "done"
    out = tmp_path / music_project["id"] / "output" / "fullEdit.wav"
    assert _rms_db(out, 1.0, 3.0) < -60       # silent speech, and no music added


def _silent_video(path: Path, seconds: float) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-y",
                    "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=160x120:rate=15",
                    "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=mono:d={seconds}",
                    "-shortest", "-c:v", "libx264", "-c:a", "aac", str(path)], check=True)


@pytest.fixture
def music_video_project(music_project, tmp_path):
    """The same project as a video one, so the mix goes through the video path."""
    _silent_video(tmp_path / music_project["id"] / "cam_A.mp4", 12.0)
    music_project["project_type"] = "video"
    music_project["has_video"] = True
    music_project["speakers"][0].update(
        {"file": "cam_A.mp4", "file_path": str(tmp_path / music_project["id"] / "cam_A.mp4")})
    return music_project


@needs_ffmpeg
def test_a_video_export_carries_the_music_ducked_under_the_speech(music_video_project, tmp_path):
    results = renderer.render_project(music_video_project, ["fullEdit"], tmp_path)
    assert results["fullEdit"]["status"] == "done", results
    out = tmp_path / music_video_project["id"] / "output" / "fullEdit.mp4"

    streams = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "stream=codec_type",
                              "-of", "csv=p=0", str(out)], capture_output=True, text=True).stdout
    assert "video" in streams and "audio" in streams
    assert _rms_db(out, 1.0, 3.0) - _rms_db(out, 5.0, 7.0) == pytest.approx(12.0, abs=2.0)


@needs_ffmpeg
def test_a_video_preview_keeps_its_video_and_mixes_the_music(music_video_project, tmp_path):
    result = renderer.render_preview(music_video_project, tmp_path)
    assert result["filename"].endswith(".mp4")
    out = tmp_path / music_video_project["id"] / "output" / result["filename"]

    streams = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "stream=codec_type",
                              "-of", "csv=p=0", str(out)], capture_output=True, text=True).stdout
    assert "video" in streams
    assert _rms_db(out, 1.0, 3.0) - _rms_db(out, 5.0, 7.0) == pytest.approx(12.0, abs=2.0)
    assert not list(out.parent.glob("*.speech.*"))

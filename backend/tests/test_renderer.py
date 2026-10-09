"""Video renders apply the editor's manual word cuts and mutes, like the preview does."""
import shutil
import subprocess

import pytest

from darkroom.services import renderer
from darkroom.services.takes import probe_duration

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _video(path, seconds: float) -> None:
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=320x240:rate=30",
                    "-f", "lavfi", "-i", f"sine=duration={seconds}", "-shortest",
                    "-c:v", "libx264", "-c:a", "aac", str(path)], check=True)


def _project(tmp_path, layout_segments):
    pid = "abcd1234"
    (tmp_path / pid).mkdir()
    _video(tmp_path / pid / "cam_A.mp4", 4)
    return {
        "id": pid,
        "speakers": [{"id": "A", "name": "A", "file_path": str(tmp_path / pid / "cam_A.mp4")}],
        "edl": {"segments": layout_segments},
        "word_cuts": [{"start": 1.0, "end": 2.0}],
        "word_mutes": [{"start": 0.2, "end": 0.4}],
    }


@pytest.mark.parametrize("layout", ["edl", "split"])
def test_full_edit_applies_word_cuts(tmp_path, layout):
    proj = _project(tmp_path, [{"id": "s1", "start": 0, "end": 3, "keep": True, "camera": "A"},
                               {"id": "s2", "start": 3, "end": 4, "keep": False, "camera": "A"}])

    results = renderer.render_project(proj, ["fullEdit"], tmp_path, camera_layout=layout)

    assert results["fullEdit"]["status"] == "done", results
    assert probe_duration(tmp_path / proj["id"] / "output" / "fullEdit.mp4") == pytest.approx(2.0, abs=0.15)


def test_word_cuts_keep_segment_fields():
    pieces = renderer._apply_word_cuts(
        [{"id": "s1", "start": 0, "end": 3, "keep": True, "camera": "B"}], [{"start": 1, "end": 2}])
    assert pieces == [{"id": "s1", "start": 0, "end": 1, "keep": True, "camera": "B"},
                      {"id": "s1", "start": 2, "end": 3, "keep": True, "camera": "B"}]


def test_mute_filter_is_relative_to_clip():
    assert renderer._mute_filter([{"start": 5.2, "end": 5.4}], 5.0, 8.0) == \
        ",volume=0:enable='between(t,0.200,0.400)'"
    assert renderer._mute_filter([{"start": 1, "end": 2}], 5.0, 8.0) == ""


def test_cleanup_gate_tracks_noise_floor():
    # Noise at -70 dBFS lifted by 20 dB: the expander opens 10 dB above it
    assert "agate=threshold=0.01000:" in renderer._cleanup_filter(20, -70)
    # A noisy recording never gets a threshold above -30 dBFS, so speech is left alone
    assert "agate=threshold=0.03162:" in renderer._cleanup_filter(22, -60)

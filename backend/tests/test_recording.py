"""In-app recordings arrive as streamed WebM with no duration; upload must fix that."""
import shutil
import subprocess

import pytest

from darkroom.api.media import _has_duration, _normalize_recording

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _ffmpeg(*args: str) -> bytes:
    return subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", "sine=duration=2", *args],
                          capture_output=True, check=True).stdout


def test_streamed_webm_is_converted_to_seekable_flac(tmp_path):
    # Writing to a pipe produces what MediaRecorder does: no duration in the header.
    src = tmp_path / "cam_A_alice.webm"
    src.write_bytes(_ffmpeg("-c:a", "libopus", "-f", "webm", "pipe:1"))
    assert not _has_duration(src)

    out = _normalize_recording(src)

    assert out == tmp_path / "cam_A_alice.flac"
    assert not src.exists()
    assert _has_duration(out)


def test_regular_upload_is_left_alone(tmp_path):
    src = tmp_path / "cam_A_alice.webm"
    _ffmpeg("-c:a", "libopus", str(src))  # seekable file written with a duration
    assert _has_duration(src)

    assert _normalize_recording(src) == src
    assert src.exists()


def test_non_recording_formats_are_not_probed(tmp_path):
    src = tmp_path / "cam_A_alice.mp3"
    src.write_bytes(b"not really audio")
    assert _normalize_recording(src) == src

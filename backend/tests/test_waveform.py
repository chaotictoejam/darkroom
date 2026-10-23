"""The timeline waveform spans the whole file, so loud parts line up in time."""
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from darkroom import storage
from darkroom.api import media
from darkroom.main import app

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def test_waveform_buckets_cover_the_whole_file(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr(media, "PROJECTS_DIR", tmp_path)
    proj = storage.new_project("t")
    storage.save_project(proj)
    # 60 s of silence then a 1.3 s tone
    subprocess.run(
        ["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=60",
         "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1.3",
         "-filter_complex", "[0][1]concat=n=2:v=0:a=1", str(tmp_path / proj["id"] / "cam_A.wav")],
        check=True,
    )
    duration = 61.3
    # A bucket count that doesn't divide the samples evenly (whole-sample
    # buckets would leave out the end and put the tone at ~61.2 s)
    buckets = 2453
    r = TestClient(app).get(f"/api/projects/{proj['id']}/waveform", params={"speaker": "cam_A.wav", "buckets": buckets})
    assert r.status_code == 200
    waveform = r.json()["waveform"]
    assert len(waveform) == buckets

    first_loud = next(i for i, v in enumerate(waveform) if v > 0.5)
    assert first_loud * duration / buckets == pytest.approx(60.0, abs=0.05)
    assert max(waveform[: int(59.5 * buckets / duration)]) < 0.01

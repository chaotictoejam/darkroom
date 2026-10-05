"""Transcription speed-ups: model cache, device/compute type, batched VAD pipeline, real progress."""
import shutil
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from darkroom.api import jobs as jobs_api
from darkroom.services import transcription as tr


class _FakeModel:
    loads: list[tuple] = []

    def __init__(self, name, device="cpu", compute_type="default"):
        if device == "cuda" and getattr(_FakeModel, "fail_cuda", False):
            raise RuntimeError("libcublas not found")
        _FakeModel.loads.append((name, device, compute_type))
        self.model = SimpleNamespace(device=device)


@pytest.fixture
def fake_models(monkeypatch):
    _FakeModel.loads = []
    _FakeModel.fail_cuda = False
    monkeypatch.setattr(tr, "WhisperModel", _FakeModel)
    monkeypatch.setattr(tr, "_model_cache", {})
    monkeypatch.setattr(tr, "_pick_device", lambda: ("cpu", "int8"))
    return _FakeModel


# ── Device and compute type ───────────────────────────────────────────────────

def test_cpu_uses_int8(monkeypatch):
    monkeypatch.setattr(tr.ctranslate2, "get_cuda_device_count", lambda: 0)
    assert tr._pick_device() == ("cpu", "int8")


def test_cuda_prefers_float16(monkeypatch):
    monkeypatch.setattr(tr.ctranslate2, "get_cuda_device_count", lambda: 1)
    monkeypatch.setattr(tr.ctranslate2, "get_supported_compute_types",
                        lambda d: {"float32", "int8_float16", "float16"})
    assert tr._pick_device() == ("cuda", "float16")


def test_cuda_without_float16_uses_next_best(monkeypatch):
    monkeypatch.setattr(tr.ctranslate2, "get_cuda_device_count", lambda: 1)
    monkeypatch.setattr(tr.ctranslate2, "get_supported_compute_types", lambda d: {"float32", "int8_float32"})
    assert tr._pick_device() == ("cuda", "float32")


def test_batch_size_scales_with_memory(monkeypatch):
    monkeypatch.setattr(tr, "_total_memory_gb", lambda: 32.0)
    assert tr._batch_size("cpu") == 8
    monkeypatch.setattr(tr, "_total_memory_gb", lambda: 4.0)
    assert tr._batch_size("cpu") == 2
    monkeypatch.setattr(tr, "_total_memory_gb", lambda: None)
    assert tr._batch_size("cpu") == 4
    monkeypatch.setattr(tr, "_free_gpu_memory_gb", lambda: 10.0)
    assert tr._batch_size("cuda") == 16


# ── Model cache ───────────────────────────────────────────────────────────────

def test_model_loaded_once_and_reused(fake_models):
    first = tr.get_model("turbo")
    assert tr.get_model("turbo") is first
    assert fake_models.loads == [("turbo", "cpu", "int8")]


def test_switching_model_evicts_previous(fake_models):
    tr.get_model("turbo")
    tr.get_model("small")
    tr.get_model("turbo")
    assert [name for name, *_ in fake_models.loads] == ["turbo", "small", "turbo"]


def test_preload_without_download_skips_missing_model(fake_models, monkeypatch):
    def not_on_disk(name, local_files_only=False):
        raise FileNotFoundError(name)

    monkeypatch.setattr(tr, "download_model", not_on_disk)
    assert tr.get_model("large", download=False) is None
    assert fake_models.loads == []


def test_cuda_load_failure_falls_back_to_cpu(fake_models, monkeypatch):
    fake_models.fail_cuda = True
    monkeypatch.setattr(tr, "_pick_device", lambda: ("cuda", "float16"))
    model = tr.get_model("turbo")
    assert model.model.device == "cpu"
    assert fake_models.loads == [("turbo", "cpu", "int8")]


def test_preload_endpoint(monkeypatch):
    calls = []
    monkeypatch.setattr(jobs_api, "preload_model", lambda name, download=False: calls.append((name, download)))
    from darkroom.main import app
    res = TestClient(app).post("/api/transcription/preload", json={"model": "small", "download": True})
    assert res.status_code == 200
    assert calls == [("small", True)]


# ── transcribe_file ───────────────────────────────────────────────────────────

def _seg(start, end, text, no_speech=0.0, logprob=-0.2):
    return SimpleNamespace(
        start=start, end=end, text=f" {text}", no_speech_prob=no_speech, avg_logprob=logprob,
        compression_ratio=1.2, words=[SimpleNamespace(word=f" {text}", start=start, end=end)],
    )


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_transcribe_file_uses_vad_batches_and_real_progress(tmp_path, fake_models, monkeypatch):
    audio = tmp_path / "talk.wav"
    subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", "sine=frequency=300:duration=10",
                    str(audio)], check=True)

    seen = {}

    class FakePipeline:
        def __init__(self, model):
            seen["model"] = model

        def transcribe(self, audio_np, **kwargs):
            seen["kwargs"] = kwargs
            segments = [
                _seg(1.0, 2.5, "Welcome to the show"),
                # Chunk-level no_speech_prob is high but decoding was confident: keep it
                _seg(4.0, 5.0, "Today we talk about editing", no_speech=0.7, logprob=-0.3),
                # Likely silence and low confidence: drop it
                _seg(6.0, 7.0, "Thanks for watching", no_speech=0.8, logprob=-1.5),
                _seg(8.0, 10.0, "Let's get started"),
            ]
            return iter(segments), SimpleNamespace(duration=10.0)

    monkeypatch.setattr(tr, "BatchedInferencePipeline", FakePipeline)
    progress = []
    segments = tr.transcribe_file(str(audio), "A", "Ana", "turbo", language="en",
                                  progress_callback=progress.append)

    assert seen["kwargs"]["vad_filter"] is True
    assert seen["kwargs"]["word_timestamps"] is True
    # Timestamp tokens make the batched pipeline drop speech; segments come from word times
    assert seen["kwargs"]["without_timestamps"] is True
    assert seen["kwargs"]["batch_size"] >= 1
    assert seen["kwargs"]["language"] == "en"
    assert [s["text"] for s in segments] == ["Welcome to the show", "Today we talk about editing", "Let's get started"]
    assert segments[0]["speaker_id"] == "A" and segments[0]["words"][0]["start"] == 1.0
    assert progress == pytest.approx([0.25, 0.5, 0.7, 1.0])
    assert progress == sorted(progress)


def test_chunks_split_into_sentences_at_punctuation_and_pauses():
    def w(word, start, end):
        return {"word": word, "start": start, "end": end}

    words = [w(" Hello", 0.0, 0.4), w(" there.", 0.4, 0.8), w(" How", 1.0, 1.2), w(" are", 1.2, 1.4),
             w(" you", 1.4, 1.6), w(" doing", 3.0, 3.4), w(" today?", 3.4, 3.9), w(" Good", 4.0, 4.3)]
    parts = tr._split_sentences(words)
    assert ["".join(x["word"] for x in p).strip() for p in parts] == [
        "Hello there.", "How are you", "doing today?", "Good"]

"""Transcription speed-ups: model cache, device/compute type, batched VAD pipeline, real progress."""
import shutil
import subprocess
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from darkroom.api import jobs as jobs_api
from darkroom.services import transcription as tr


class _FakeModel:
    loads: list[tuple] = []

    def __init__(self, name, device="cpu", compute_type="default", cpu_threads=0):
        if device == "cuda" and getattr(_FakeModel, "fail_cuda", False):
            raise RuntimeError("libcublas not found")
        _FakeModel.loads.append((name, device, compute_type))
        _FakeModel.threads.append(cpu_threads)
        self.model = SimpleNamespace(device=device)


@pytest.fixture
def fake_models(monkeypatch):
    _FakeModel.loads = []
    _FakeModel.threads = []
    _FakeModel.fail_cuda = False
    monkeypatch.setattr(tr, "_physical_cores", lambda: 6)
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


def test_batch_size(monkeypatch):
    # CPU: batches help small models but not large ones (Phase 0); GPU scales with free memory
    assert tr._batch_size("cpu", "small") == 4
    assert tr._batch_size("cpu", "turbo") == 1
    monkeypatch.setattr(tr, "_free_gpu_memory_gb", lambda: 10.0)
    assert tr._batch_size("cuda", "turbo") == 16


# ── Model cache ───────────────────────────────────────────────────────────────

def test_model_loaded_once_and_reused(fake_models):
    first = tr.get_model("turbo")
    assert tr.get_model("turbo") is first
    assert fake_models.loads == [("turbo", "cpu", "int8")]


def test_cpu_uses_every_physical_core(fake_models, monkeypatch):
    tr.get_model("turbo")
    monkeypatch.setattr(tr, "_pick_device", lambda: ("cuda", "float16"))
    tr.get_model("small")
    assert fake_models.threads == [6, 0]  # 0 = CTranslate2's default; ignored on CUDA


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


def test_broken_cuda_probe_reports_cpu_fallback(monkeypatch):
    def broken_probe():
        raise RuntimeError("driver internal detail")

    monkeypatch.setattr(tr.ctranslate2, "get_cuda_device_count", broken_probe)
    warnings = []
    assert tr._pick_device(warnings.append) == ("cpu", "int8")
    assert warnings == ["CUDA could not be checked"]
    monkeypatch.setattr(tr.ctranslate2, "get_cuda_device_count", lambda: 0)
    warnings.clear()
    assert tr._pick_device(warnings.append) == ("cpu", "int8")
    assert not warnings


def test_transcription_job_reports_cuda_load_failure_in_progress(fake_models, monkeypatch):
    fake_models.fail_cuda = True
    monkeypatch.setattr(tr, "_pick_device", lambda warning_callback=None: ("cuda", "float16"))
    monkeypatch.setattr(tr, "_load_window", lambda *_: np.zeros(16000, dtype=np.float32))

    class FakePipeline:
        def __init__(self, model):
            assert model.model.device == "cpu"

        def transcribe(self, *_args, **_kwargs):
            return iter([_seg(0.0, 1.0, "Hello")]), None

    class InlineThread:
        def __init__(self, *, target, daemon):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(tr, "BatchedInferencePipeline", FakePipeline)
    monkeypatch.setattr(jobs_api.threading, "Thread", InlineThread)
    project = {
        "transcribe_model": "turbo",
        "speakers": [{"id": "speaker", "name": "Speaker", "file_path": "ignored.wav"}],
    }
    updates = []
    monkeypatch.setattr(jobs_api, "get_project", lambda _: project)
    monkeypatch.setattr(jobs_api, "_update_progress", lambda _, **update: updates.append(update))
    jobs_api.start_transcription("test-project")

    progress = [update["progress"] for update in updates]
    cpu_messages = [item for item in progress if "transcribing on CPU" in item["message"]]
    assert [item["percent"] for item in cpu_messages] == [10, 65]
    assert all("CUDA model could not be loaded" in item["message"] for item in cpu_messages)
    assert all("libcublas" not in item["message"] for item in progress)
    assert updates[-1]["status"] == "transcribed"


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


def _speech(spans, duration, rate=16000):
    """Quiet noise with a loud tone over each (start, end) span, as float32 audio."""
    rng = np.random.default_rng(0)
    audio = rng.normal(0, 0.001, int(duration * rate)).astype(np.float32)
    t = np.arange(len(audio)) / rate
    for start, end in spans:
        on = (t >= start) & (t < end)
        audio[on] += 0.3 * np.sin(2 * np.pi * 200 * t[on]).astype(np.float32)
    return audio


def _words_seg(*words):
    ws = [{"word": f" {w}", "start": s, "end": e} for w, s, e in words]
    return {"text": " ".join(w for w, _, _ in words), "start": ws[0]["start"], "end": ws[-1]["end"], "words": ws}


def test_word_edges_move_onto_the_silence():
    # Whisper ends "tell," 0.2 s before the sound stops and starts "I" just after it begins
    audio = _speech([(1.0, 2.2), (2.5, 3.5)], 5.0)
    segs = [_words_seg(("tell,", 1.0, 2.0)), _words_seg(("I", 2.55, 3.5))]
    tr.refine_word_edges(segs, audio, 16000)
    assert segs[0]["words"][0]["end"] == pytest.approx(2.2, abs=0.02)
    assert segs[1]["words"][0]["start"] == pytest.approx(2.5, abs=0.02)
    # Segment times follow their words
    assert segs[0]["end"] == segs[0]["words"][0]["end"]
    assert segs[1]["start"] == segs[1]["words"][0]["start"]


def test_word_edge_moves_are_capped():
    audio = _speech([(1.0, 3.0), (3.5, 4.0)], 5.0)
    segs = [_words_seg(("long", 1.0, 2.0), ("next", 3.9, 4.0))]
    tr.refine_word_edges(segs, audio, 16000)
    words = segs[0]["words"]
    assert words[0]["end"] == pytest.approx(2.0 + tr._EDGE_MAX_TAIL_S)
    assert words[1]["start"] == pytest.approx(3.9 - tr._EDGE_MAX_HEAD_S)


def test_silence_inside_a_word_is_trimmed():
    # Whisper starts "because" 0.8 s before the sound and ends "remembers." 0.3 s after it
    # A click right where "because" starts doesn't count as its sound
    audio = _speech([(1.0, 1.5), (1.71, 1.72), (2.5, 3.0), (4.0, 4.5)], 5.0)
    segs = [_words_seg(("it", 1.0, 1.5), ("because", 1.7, 3.0)), _words_seg(("remembers.", 4.0, 4.8))]
    tr.refine_word_edges(segs, audio, 16000)
    assert segs[0]["words"][1]["start"] == pytest.approx(2.5 - tr._EDGE_TRIM_PAD_S, abs=0.02)
    assert segs[1]["words"][0]["end"] == pytest.approx(4.5 + tr._EDGE_TRIM_PAD_S, abs=0.02)


def test_short_quiet_start_is_kept():
    # Under _EDGE_MIN_TRIM_S of quiet: could be a soft "h" or "s", so the start stays
    audio = _speech([(1.0, 1.5), (2.1, 3.0)], 5.0)
    segs = [_words_seg(("it", 1.0, 1.5), ("honestly", 2.0, 3.0))]
    tr.refine_word_edges(segs, audio, 16000)
    assert segs[0]["words"][1]["start"] == 2.0


def test_gap_without_silence_is_left_alone():
    audio = _speech([(1.0, 3.0)], 5.0)
    segs = [_words_seg(("one", 1.0, 2.0), ("two", 2.4, 3.0))]
    tr.refine_word_edges(segs, audio, 16000)
    assert [(w["start"], w["end"]) for w in segs[0]["words"]] == [(1.0, 2.0), (2.4, 3.0)]


def test_short_replies_are_kept_but_loops_are_dropped():
    def seg(text):
        return {"text": text, "start": 0.0, "end": 1.0, "words": []}

    kept = tr._filter_hallucinations([
        seg("Yeah."), seg("Okay, sure."), seg("okay okay okay okay okay"),
        seg("you know you know you know you know"), seg("That sounds good."),
    ])
    assert [s["text"] for s in kept] == ["Yeah.", "Okay, sure.", "That sounds good."]


def test_default_model_depends_on_device_and_language(monkeypatch):
    monkeypatch.setattr(tr, "_pick_device", lambda: ("cpu", "int8"))
    assert tr.default_model("en") == "small"
    assert tr.default_model("fr") == "turbo"
    assert tr.default_model(None) == "turbo"  # auto-detect
    monkeypatch.setattr(tr, "_pick_device", lambda: ("cuda", "float16"))
    assert tr.default_model("en") == "turbo"


def test_defaults_endpoint_and_preload_without_model(monkeypatch):
    monkeypatch.setattr(tr, "_pick_device", lambda: ("cpu", "int8"))
    calls = []
    monkeypatch.setattr(jobs_api, "preload_model", lambda name, download=False: calls.append(name))
    from darkroom.main import app
    client = TestClient(app)
    assert client.get("/api/transcription/defaults").json() == {
        "device": "cpu", "compute_type": "int8", "default_model": "small"}
    assert client.get("/api/transcription/defaults?language=de").json()["default_model"] == "turbo"
    assert client.get("/api/transcription/defaults?language=").json()["default_model"] == "turbo"
    client.post("/api/transcription/preload", json={})
    client.post("/api/transcription/preload", json={"language": "es"})
    assert calls == ["small", "turbo"]


# ── Repetitive speech vs. hallucinated loops ──────────────────────────────────

def _chunk(text, words):
    """One decoded chunk: whole-chunk text plus its word timings."""
    return SimpleNamespace(
        start=words[0][1], end=words[-1][2], text=text,
        no_speech_prob=0.1, avg_logprob=-0.2, compression_ratio=9.9,
        words=[SimpleNamespace(word=" " + w, start=s, end=e) for w, s, e in words],
    )


def _decode_chunks(chunks, monkeypatch, fake_models, duration=40.0):
    class FakePipeline:
        def __init__(self, model):
            pass

        def transcribe(self, audio_np, **kwargs):
            return iter(chunks), SimpleNamespace(duration=duration)

    monkeypatch.setattr(tr, "BatchedInferencePipeline", FakePipeline)
    # Silent audio: refine_word_edges leaves word times alone when it finds no sound
    return tr._decode(np.zeros(int(duration * 16000), dtype=np.float32), "A", "Ana", "small", "en")


def test_a_restated_line_is_kept_even_though_the_chunk_looks_repetitive(fake_models, monkeypatch):
    """A speaker doing a retake used to lose the whole 30 s chunk.

    Without timestamp tokens a chunk is up to 30 s of speech. Someone who says
    a line, fluffs it, and says it again compresses well as one block, so the
    per-chunk compression check dropped every word of it. The check belongs on
    each sentence instead.
    """
    # The real line from the recording this was found in, said three times
    line = ("On Tuesday, November 17th, the chair of that board said on the earnings "
            "call that the board does not intend to reinstate Jensen as CEO.").split()
    words, t = [], 1.0
    for _ in range(3):
        for w in line:
            words.append((w, round(t, 2), round(t + 0.4, 2)))
            t += 0.5
        t += 0.2
    chunk_text = " ".join(w for w, _, _ in words)
    assert tr._compression_ratio(chunk_text) > tr._COMPRESSION_RATIO_MAX

    segments = _decode_chunks([_chunk(chunk_text, words)], monkeypatch, fake_models)
    assert len(segments) == 3
    assert all(s["text"] == " ".join(line) for s in segments)
    # The speech is still covered end to end, not thrown away
    assert segments[0]["start"] == 1.0 and segments[-1]["end"] == words[-1][2]


def test_a_loop_inside_one_sentence_is_still_dropped(fake_models, monkeypatch):
    words = [("you", round(0.5 * i, 2), round(0.5 * i + 0.3, 2)) for i in range(40)]
    text = " ".join(w for w, _, _ in words)
    assert tr._compression_ratio(text) > tr._COMPRESSION_RATIO_MAX
    assert _decode_chunks([_chunk(text, words)], monkeypatch, fake_models) == []


def test_compression_ratio_of_empty_text():
    assert tr._compression_ratio("") == 0.0


# ── Splicing a re-transcribed range in ────────────────────────────────────────

def _seg_words(speaker, *spec):
    words = [{"word": " " + w, "start": s, "end": e} for w, s, e in spec]
    return {
        "speaker_id": speaker, "speaker_name": speaker, "start": words[0]["start"],
        "end": words[-1]["end"], "text": "".join(w["word"] for w in words).strip(), "words": words,
    }


def test_splice_replaces_only_the_range():
    before = _seg_words("A", ("Before", 0.0, 1.0))
    inside = _seg_words("A", ("junk", 5.0, 6.0))
    after = _seg_words("A", ("After", 20.0, 21.0))
    fresh = [_seg_words("A", ("Recovered", 5.5, 7.0))]

    out = tr.splice_segments([before, inside, after], fresh, 4.0, 10.0)
    assert [s["text"] for s in out] == ["Before", "Recovered", "After"]


def test_splice_keeps_the_words_of_a_straddling_segment():
    straddling = _seg_words("A", ("Keep", 1.0, 2.0), ("me", 2.0, 3.0), ("drop", 5.0, 6.0))
    out = tr.splice_segments([straddling], [_seg_words("A", ("New", 5.1, 5.9))], 4.0, 8.0)
    assert [s["text"] for s in out] == ["Keep me", "New"]
    assert out[0]["end"] == 3.0 and len(out[0]["words"]) == 2


def test_splice_drops_a_segment_swallowed_by_the_range():
    out = tr.splice_segments([_seg_words("A", ("gone", 5.0, 6.0))], [], 4.0, 8.0)
    assert out == []


def test_splice_leaves_other_speakers_alone():
    mine = _seg_words("A", ("mine", 5.0, 6.0))
    theirs = _seg_words("B", ("theirs", 5.0, 6.0))
    out = tr.splice_segments([mine, theirs], [_seg_words("A", ("new", 5.2, 5.8))], 4.0, 8.0, speaker_id="A")
    # In time order; the other speaker's words in the range are untouched
    assert [s["text"] for s in out] == ["theirs", "new"]


def test_splice_drops_a_wordless_segment_in_the_range():
    wordless = {"speaker_id": "A", "speaker_name": "A", "start": 5.0, "end": 6.0, "text": "hm", "words": []}
    assert tr.splice_segments([wordless], [], 4.0, 8.0) == []


def test_transcribe_range_returns_empty_for_an_inverted_range():
    assert tr.transcribe_range("nofile.wav", "A", "Ana", 10.0, 10.0) == []


# ── Extracting one window of a track ──────────────────────────────────────────

@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_a_window_is_extracted_at_the_sample(tmp_path):
    """Real ffmpeg: a window starts exactly where asked and is the length asked for.

    A tone that changes pitch at 2 s, so the window's contents prove where it
    actually starts — not just that ffmpeg exited cleanly.
    """
    track = tmp_path / "track.wav"
    subprocess.run(
        ["ffmpeg", "-v", "quiet", "-y",
         "-f", "lavfi", "-i", "sine=frequency=200:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=2000:duration=3",
         "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1", str(track)],
        check=True,
    )

    whole = tr._load_window(str(track))
    assert len(whole) == pytest.approx(5 * tr._SAMPLE_RATE, abs=tr._SAMPLE_RATE // 10)

    window = tr._load_window(str(track), 2.0, 1.0)
    assert len(window) == pytest.approx(tr._SAMPLE_RATE, abs=tr._SAMPLE_RATE // 50)
    # The window holds the high tone that starts at 2 s, not the low one before it
    spectrum = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(window), 1 / tr._SAMPLE_RATE)
    assert freqs[int(np.argmax(spectrum))] == pytest.approx(2000, abs=50)


def test_splice_keeps_a_word_the_range_edge_lands_inside():
    """A range that ends part-way through a word keeps that word.

    Re-transcribing 63.5–96.0 to recover a gap should not delete the "Six" of
    "Six days later" just because the edge fell inside it.
    """
    after = _seg_words("A", ("Six", 95.83, 96.21), ("days", 96.21, 96.6), ("later", 96.6, 97.0))
    out = tr.splice_segments([after], [_seg_words("A", ("recovered", 90.0, 95.6))], 63.5, 96.0)
    assert [s["text"] for s in out] == ["recovered", "Six days later"]


def test_count_words_in_range_uses_the_same_edge_rule_as_the_splice():
    seg = _seg_words("A", ("out", 1.0, 2.0), ("edge", 2.0, 4.0), ("in", 5.0, 6.0))
    other = _seg_words("B", ("theirs", 5.0, 6.0))
    # "edge" straddles 3.0 and sits mostly after it, so it counts as inside
    assert tr.count_words_in_range([seg, other], 3.0, 10.0) == 3
    assert tr.count_words_in_range([seg, other], 3.0, 10.0, speaker_id="A") == 2
    assert tr.count_words_in_range([seg], 4.5, 10.0) == 1
    assert tr.count_words_in_range([], 0.0, 10.0) == 0

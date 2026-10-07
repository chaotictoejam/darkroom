"""
transcription.py — Whisper transcription and transcript merge

Models are loaded once and cached (see ``get_model``); every track is decoded
with Silero VAD and faster-whisper's batched pipeline, so silence is skipped
and speech is decoded several 30 s windows at a time.
"""

import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import wave
from collections import Counter

import ctranslate2
import numpy as np
from faster_whisper import BatchedInferencePipeline, WhisperModel, download_model

logger = logging.getLogger(__name__)

# Default model, from the Phase 0 benchmark. In English on CPU, small matched
# turbo's accuracy at about 3x the speed; in Spanish, French and German it made
# 1.7x turbo's errors (14.5% against 8.5% WER). On an NVIDIA GPU both take a
# minute or two per hour of audio, so turbo is the default there in any language.
DEFAULT_MODEL_FAST = "small"
DEFAULT_MODEL_ACCURATE = "turbo"

_SAMPLE_RATE = 16000


# ── Model cache ───────────────────────────────────────────────────────────────

# Only the most recently used model is kept: large-v3 alone is ~1.5 GB in int8,
# so holding every model a user has tried would exhaust RAM. A job still using
# an evicted model keeps its own reference until it finishes.
_model_cache: dict[tuple[str, str, str], WhisperModel] = {}
_model_lock = threading.Lock()


def _pick_device() -> tuple[str, str]:
    """(device, compute_type): float16 on an NVIDIA GPU, int8 on CPU."""
    try:
        if ctranslate2.get_cuda_device_count() > 0:
            supported = ctranslate2.get_supported_compute_types("cuda")
            for compute_type in ("float16", "int8_float16", "float32"):
                if compute_type in supported:
                    return "cuda", compute_type
    except Exception:  # broken CUDA install: fall through to CPU
        logger.exception("CUDA check failed; using CPU")
    return "cpu", "int8"


def _physical_cores() -> int:
    """Physical CPU cores, or 0 (CTranslate2's default of 4 threads) if unknown.

    Phase 0: using every physical core was about 20% faster than the default;
    hyper-threads added nothing.
    """
    try:
        if sys.platform.startswith("linux"):
            cores, ids = set(), {}
            with open("/proc/cpuinfo") as f:
                for line in f:
                    key, _, value = line.partition(":")
                    ids[key.strip()] = value.strip()
                    if key.strip() == "core id":
                        cores.add((ids.get("physical id"), value.strip()))
            return len(cores)
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "hw.physicalcpu"], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return 0


def _load(model_name: str, device: str, compute_type: str) -> WhisperModel:
    cpu_threads = _physical_cores() if device == "cpu" else 0
    return WhisperModel(model_name, device=device, compute_type=compute_type, cpu_threads=cpu_threads)


def default_model(language: str | None = "en") -> str:
    """The Whisper model to use when the user hasn't chosen one.

    ``small`` only for English on CPU; ``turbo`` on GPU, and on CPU for other
    languages or auto-detect (``language=None``).
    """
    if _pick_device()[0] == "cpu" and language == "en":
        return DEFAULT_MODEL_FAST
    return DEFAULT_MODEL_ACCURATE


def transcription_defaults(language: str | None = "en") -> dict:
    """What this machine transcribes on, and the model the app recommends for it."""
    device, compute_type = _pick_device()
    return {"device": device, "compute_type": compute_type, "default_model": default_model(language)}


def get_model(model_name: str, *, download: bool = True) -> WhisperModel | None:
    """Return a cached WhisperModel, loading it on first use.

    With ``download=False`` a model that isn't on disk yet returns None instead
    of being downloaded (used for preloading, so browsing the model picker
    never starts a multi-GB download).
    """
    device, compute_type = _pick_device()
    key = (model_name, device, compute_type)
    with _model_lock:
        model = _model_cache.get(key)
        if model is not None:
            return model
        if not download:
            try:
                download_model(model_name, local_files_only=True)
            except Exception:
                return None
        try:
            model = _load(model_name, device, compute_type)
        except Exception:
            if device == "cpu":
                raise
            # e.g. CUDA driver present but cuBLAS/cuDNN missing
            logger.exception("Could not load %s on %s; falling back to CPU", model_name, device)
            key = (model_name, "cpu", "int8")
            model = _load(model_name, "cpu", "int8")
        _model_cache.clear()
        _model_cache[key] = model
        return model


def preload_model(model_name: str, *, download: bool = False) -> None:
    """Load a model in the background so the first transcription starts at once."""
    def _load() -> None:
        try:
            get_model(model_name, download=download)
        except Exception:
            logger.exception("Preloading Whisper model %s failed", model_name)

    threading.Thread(target=_load, daemon=True).start()


def _total_memory_gb() -> float | None:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
    except (AttributeError, ValueError, OSError):  # e.g. Windows
        return None


def _free_gpu_memory_gb() -> float | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        return int(out.split()[0]) / 1024
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _batch_size(device: str) -> int:
    """How many 30 s windows to decode at once, from the memory available.

    Phase 0: on GPU, batch 16 was 20% faster than batch 1; on CPU, batches
    above 4 were slightly slower, so CPU is capped at 4.
    """
    if device == "cuda":
        free = _free_gpu_memory_gb()
        if free is None:
            return 8
        return 16 if free >= 8 else 8 if free >= 4 else 4
    total = _total_memory_gb()
    if total is None:
        return 4
    return 4 if total >= 8 else 2


def _extract_audio(video_path: str) -> str:
    """
    Extract mono 16 kHz WAV from a video file using ffmpeg.
    Returns path to a temp WAV file (caller must delete it).
    """
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "ffmpeg is not on your PATH.\n\n"
            "To fix this, add ffmpeg to your system PATH and restart Darkroom:\n"
            "  Windows : add C:\\ffmpeg\\bin to System PATH (or wherever you installed it)\n"
            "  macOS   : brew install ffmpeg\n"
            "  Linux   : sudo apt install ffmpeg"
        )

    tmp = tempfile.mktemp(suffix=".wav")
    cmd = ["ffmpeg", "-y", "-nostdin", "-i", video_path,
           "-ac", "1", "-ar", "16000", "-f", "wav", tmp]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed:\n{result.stderr.decode(errors='replace')}")
    return tmp


def _wav_to_numpy(wav_path: str) -> np.ndarray:
    """Load a mono 16 kHz WAV as a float32 numpy array (Whisper's native format)."""
    with wave.open(wav_path, "rb") as wf:
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe_file(
    file_path: str,
    speaker_id: str,
    speaker_name: str,
    model_name: str | None = None,
    language: str | None = None,
    progress_callback=None,
) -> list[dict]:
    """Transcribe a single video/audio file using Whisper. Returns list of segment dicts.

    progress_callback(frac: float) is called as segments are decoded, with the
    fraction (0.0–1.0) of this speaker's audio covered so far. The caller maps
    this onto the overall job percentage.
    """
    audio_path = _extract_audio(file_path)
    try:
        audio_np = _wav_to_numpy(audio_path)
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass

    audio_duration = len(audio_np) / _SAMPLE_RATE
    model = get_model(model_name or default_model(language))
    pipeline = BatchedInferencePipeline(model)
    segments_iter, _info = pipeline.transcribe(
        audio_np,
        language=language,
        batch_size=_batch_size(model.model.device),
        # Silero VAD: only speech is decoded, which skips silence and removes the
        # main source of hallucinations
        vad_filter=True,
        word_timestamps=True,
        # Timestamp tokens make the batched pipeline drop speech after a chunk's
        # last timestamp (it decodes each chunk once, with no re-seek), so decode
        # text only and split chunks into sentences from word times below
        without_timestamps=True,
        # temperature=0 forces greedy decoding — far less likely to hallucinate loops
        temperature=0,
        # Don't feed previous segment text as context — prevents one hallucination
        # from snowballing into the next segment
        condition_on_previous_text=False,
        # Whisper's own thresholds for dropping likely-silence segments
        no_speech_threshold=0.5,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )

    # transcribe() returns a lazy generator; progress comes from how far into the
    # track the decoded segments reach
    whisper_segments = []
    for seg in segments_iter:
        whisper_segments.append(seg)
        if progress_callback and audio_duration > 0:
            progress_callback(min(1.0, seg.end / audio_duration))

    segments = []
    for seg in whisper_segments:
        # Whisper's rule for silence: likely no speech AND low confidence. The
        # batched pipeline reports no_speech_prob per 30 s chunk, so it can't be
        # used on its own without dropping real speech next to a pause.
        if seg.no_speech_prob > 0.5 and seg.avg_logprob < -1.0:
            continue
        # Skip segments with suspiciously high compression ratio (repetitive text)
        if seg.compression_ratio > 2.4:
            continue
        words = [{"word": w.word, "start": round(float(w.start), 3), "end": round(float(w.end), 3)}
                 for w in (seg.words or [])]
        for part in _split_sentences(words) if words else [None]:
            segments.append({
                "speaker_id": speaker_id,
                "speaker_name": speaker_name,
                "start": part[0]["start"] if part else round(float(seg.start), 3),
                "end": part[-1]["end"] if part else round(float(seg.end), 3),
                "text": "".join(w["word"] for w in part).strip() if part else seg.text.strip(),
                "words": part or [],
            })

    return _filter_hallucinations(segments)


# A pause this long between words also ends a segment
_SENTENCE_GAP_S = 1.0


def _split_sentences(words: list[dict]) -> list[list[dict]]:
    """Split one decoded chunk (up to 30 s) into sentence-sized runs of words.

    A run ends after a word ending in . ? or !, or before a pause of
    _SENTENCE_GAP_S or more.
    """
    parts: list[list[dict]] = [[]]
    for i, w in enumerate(words):
        if parts[-1] and w["start"] - words[i - 1]["end"] >= _SENTENCE_GAP_S:
            parts.append([])
        parts[-1].append(w)
        if w["word"].strip().endswith((".", "?", "!")):
            parts.append([])
    return [p for p in parts if p]


def transcribe_all(speakers: list[dict], model_name: str | None = None, progress_callback=None, language: str | None = None) -> dict[str, list]:
    """Transcribe all speaker files. Returns {speaker_id: [segments]}.

    progress_callback(overall_frac: float, name: str, index: int, total: int)
    is called at the start of each speaker and then every ~1.5 s during
    transcription, with overall_frac in [0, 1).
    """
    transcripts = {}
    total = len(speakers)

    for i, speaker in enumerate(speakers):
        # Fire immediately so the UI shows the speaker name before the first tick
        if progress_callback:
            progress_callback(i / total, speaker["name"], i, total)

        # Capture loop variables in defaults to avoid closure-over-loop-variable bugs
        def _inner(frac: float, *, _i: int = i, _name: str = speaker["name"]) -> None:
            if progress_callback:
                overall = (_i + frac) / total
                progress_callback(overall, _name, _i, total)

        segments = transcribe_file(
            speaker["file_path"],
            speaker["id"],
            speaker["name"],
            model_name,
            language=language,
            progress_callback=_inner,
        )
        transcripts[speaker["id"]] = segments

    return transcripts


def _normalise(word: str) -> str:
    return word.lower().strip(".,!?\"'")


def _filter_hallucinations(segments: list[dict]) -> list[dict]:
    """
    Remove Whisper hallucination artifacts:

    1. Within-segment loops  — "okay okay okay okay"
    2. Repeating-phrase loops — "you know you know you know"
    3. Cross-segment runs    — 3+ consecutive segments with the same 1-2 word text

    Short filler-only segments ("Okay.", "Yeah, yeah.") are kept: with VAD only
    speech is decoded, and in Phase 0 dropping them deleted real replies and
    cost 1.6–2.8 points of word error rate on meetings.
    """
    # --- Pass 1: per-segment checks ---
    pass1 = []
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue

        words = text.split()
        norm = [_normalise(w) for w in words]

        # Within-segment word loop: "okay okay okay okay"
        if len(words) >= 4:
            counts = Counter(norm)
            top_word, top_count = counts.most_common(1)[0]
            if top_count >= 4 and top_count / len(words) > 0.55:
                continue

        # Within-segment phrase loop: "you know you know you know"
        is_phrase_loop = False
        for phrase_len in (1, 2, 3):
            if len(words) >= phrase_len * 4:
                phrase = tuple(norm[:phrase_len])
                chunks = [
                    tuple(norm[i:i + phrase_len])
                    for i in range(0, len(norm) - phrase_len + 1, phrase_len)
                ]
                if chunks and chunks.count(phrase) / len(chunks) > 0.65:
                    is_phrase_loop = True
                    break
        if is_phrase_loop:
            continue

        pass1.append(seg)

    # --- Pass 2: cross-segment run detection ---
    # If the same short text appears in 3+ consecutive segments, drop the run.
    if not pass1:
        return pass1

    result = []
    i = 0
    while i < len(pass1):
        seg = pass1[i]
        text_norm = " ".join(_normalise(w) for w in seg["text"].split())
        word_count = len(seg["text"].split())

        # Only check short segments (≤5 words) for cross-segment runs
        if word_count <= 5:
            run_end = i + 1
            while run_end < len(pass1):
                other_norm = " ".join(_normalise(w) for w in pass1[run_end]["text"].split())
                if other_norm == text_norm:
                    run_end += 1
                else:
                    break
            run_len = run_end - i
            if run_len >= 3:
                # Drop the entire run
                i = run_end
                continue

        result.append(seg)
        i += 1

    return result


def merge_transcripts(transcripts: dict[str, list], speakers: list[dict]) -> list[dict]:
    """Merge per-speaker transcripts into a single chronological list."""
    all_segments = []
    for speaker_id, segs in transcripts.items():
        all_segments.extend(segs)
    all_segments.sort(key=lambda s: s["start"])
    return all_segments


def format_for_claude(merged_transcript: list[dict]) -> str:
    """Format merged transcript as readable text for Claude."""
    lines = []
    for seg in merged_transcript:
        start = _fmt_time(seg["start"])
        end = _fmt_time(seg["end"])
        lines.append(f"[{start} - {end}] {seg['speaker_name']}: {seg['text']}")
    return "\n".join(lines)


def _fmt_time(seconds: float) -> str:
    mins = int(seconds // 60)
    secs = seconds % 60
    return f"{mins:02d}:{secs:06.3f}"

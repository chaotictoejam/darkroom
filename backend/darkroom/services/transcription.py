"""
processor.py — Whisper transcription and transcript merge
"""

import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from collections import Counter

import numpy as np
from faster_whisper import WhisperModel

# Conservative CPU-based estimates of audio-seconds processed per wall-clock second.
# GPU will be faster; the bar will just finish early rather than overshoot.
_MODEL_SPEED: dict[str, float] = {
    "base": 12.0, "small": 8.0, "medium": 5.0,
    "large": 2.5, "large-v2": 2.5, "large-v3": 2.5,
    "turbo": 12.0,
}


def _whisper_model_kwargs() -> dict:
    """
    Hardware tuning for the underlying CTranslate2 model, read from the
    environment so it's a machine-level setting rather than a per-project
    one — see the "Tuning local performance" section in the README.

    All three default to CTranslate2's own defaults (device="auto",
    compute_type="default", cpu_threads=0 i.e. autodetect), so leaving
    these unset reproduces the exact behavior before this was configurable.
    """
    try:
        cpu_threads = int(os.getenv("WHISPER_CPU_THREADS", "0") or "0")
    except ValueError:
        cpu_threads = 0
    return {
        "device": os.getenv("WHISPER_DEVICE", "auto"),
        "compute_type": os.getenv("WHISPER_COMPUTE_TYPE", "default"),
        "cpu_threads": cpu_threads,
    }


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
    model_name: str = "base",
    language: str | None = None,
    align: bool = False,
    progress_callback=None,
) -> list[dict]:
    """Transcribe a single video/audio file using Whisper. Returns list of segment dicts.

    speaker_id/speaker_name are passed in directly, not detected — Darkroom's
    projects already separate speakers by camera/track, so there's no
    diarization step here. Guessing speaker identity from a mixed signal
    (e.g. pyannote) would be strictly less accurate than the track assignment
    the user already gave us.

    align=True runs a wav2vec2 forced-alignment pass (services/align_engine.py)
    over the word timestamps afterward — tighter word boundaries than Whisper's
    own cross-attention timestamps, at the cost of extra processing time.
    Requires the `align` extra (torch/torchaudio/transformers); silently no-ops
    if it isn't installed or the resolved language has no alignment model.

    progress_callback(frac: float) is called every ~1.5 s with an estimated
    0.0–0.95 fraction of this speaker's audio processed. The caller maps this
    onto the overall job percentage.
    """
    audio_path = _extract_audio(file_path)
    stop_event = threading.Event()
    try:
        audio_np = _wav_to_numpy(audio_path)
        audio_duration = len(audio_np) / 16000.0
        model = WhisperModel(model_name, **_whisper_model_kwargs())

        if progress_callback and audio_duration > 0:
            speed = _MODEL_SPEED.get(model_name, 5.0)
            estimated_wall = audio_duration / speed
            start = time.monotonic()

            def _tick() -> None:
                # stop_event.wait(timeout) returns True when set, False on timeout
                while not stop_event.wait(1.5):
                    elapsed = time.monotonic() - start
                    progress_callback(min(0.95, elapsed / max(estimated_wall, 1.0)))

            threading.Thread(target=_tick, daemon=True).start()

        segments_iter, info = model.transcribe(
            audio_np,
            word_timestamps=True,
            language=language,
            # temperature=0 forces greedy decoding — far less likely to hallucinate loops
            temperature=0,
            # Don't feed previous segment text as context — prevents one hallucination
            # from snowballing into the next segment
            condition_on_previous_text=False,
            # Whisper's own thresholds for dropping likely-silence segments
            no_speech_threshold=0.5,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            # Run Silero VAD first so silence/breathing never reaches the model —
            # this is a bigger accuracy win than the no_speech/log_prob thresholds
            # above, which only catch hallucinations after the fact.
            vad_filter=True,
        )
        # transcribe() returns a lazy generator — consume it now, inside the
        # try block, so the progress-ticker thread is stopped once decoding
        # actually finishes.
        whisper_segments = list(segments_iter)
    finally:
        stop_event.set()
        try:
            os.unlink(audio_path)
        except OSError:
            pass

    segments = []
    for seg in whisper_segments:
        # Skip segments Whisper itself flagged as likely silence
        if seg.no_speech_prob > 0.5:
            continue
        # Skip segments with suspiciously high compression ratio (repetitive text)
        if seg.compression_ratio > 2.4:
            continue
        segments.append({
            "speaker_id": speaker_id,
            "speaker_name": speaker_name,
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": seg.text.strip(),
            "words": [
                {"word": w.word, "start": round(float(w.start), 3), "end": round(float(w.end), 3)}
                for w in (seg.words or [])
            ],
        })

    segments = _filter_hallucinations(segments)

    if align and segments:
        from .align_engine import align_segment_words, alignment_available, default_device
        resolved_lang = (language or getattr(info, "language", None) or "en").lower()
        if alignment_available(resolved_lang):
            device = default_device()
            for seg in segments:
                if seg["words"]:
                    seg["words"] = align_segment_words(
                        seg["words"], seg["start"], seg["end"], audio_np, resolved_lang, device=device,
                    )

    return segments


def transcribe_all(speakers: list[dict], model_name: str, progress_callback=None, language: str | None = None, align: bool = False) -> dict[str, list]:
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
            align=align,
            progress_callback=_inner,
        )
        transcripts[speaker["id"]] = segments

    return transcripts


# Single-word fillers that Whisper commonly hallucinates on silence
_FILLER_WORDS = {
    "okay", "ok", "yeah", "yes", "no", "right", "alright", "hmm", "mhm",
    "uh", "um", "uhh", "umm", "mm", "mmm", "ah", "oh", "er", "erm",
    "like", "so", "well", "now", "anyway", "sure", "yep", "nope",
}


def _normalise(word: str) -> str:
    return word.lower().strip(".,!?\"'")


def _filter_hallucinations(segments: list[dict]) -> list[dict]:
    """
    Remove Whisper hallucination artifacts:

    1. Within-segment loops  — "okay okay okay okay"
    2. Repeating-phrase loops — "you know you know you know"
    3. Pure filler segments  — segment text is only 1-2 filler words
    4. Cross-segment runs    — 3+ consecutive segments with the same 1-2 word text
    """
    # --- Pass 1: per-segment checks ---
    pass1 = []
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue

        words = text.split()
        norm = [_normalise(w) for w in words]

        # Drop pure-filler segments (e.g. a segment that is just "Okay." or "Yeah, yeah.")
        real_words = [w for w in norm if w not in _FILLER_WORDS]
        if not real_words and len(words) <= 4:
            continue

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

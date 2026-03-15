"""
processor.py — Whisper transcription and transcript merge
"""

import os
import re
import shutil
import subprocess
import tempfile
import wave
from collections import Counter

import numpy as np
import whisper


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


def transcribe_file(file_path: str, speaker_id: str, speaker_name: str, model_name: str = "base") -> list[dict]:
    """Transcribe a single video/audio file using Whisper. Returns list of segment dicts."""
    audio_path = _extract_audio(file_path)
    try:
        audio_np = _wav_to_numpy(audio_path)
        model = whisper.load_model(model_name)
        result = model.transcribe(
            audio_np,
            word_timestamps=True,
            # temperature=0 forces greedy decoding — far less likely to hallucinate loops
            temperature=0,
            # Don't feed previous segment text as context — prevents one hallucination
            # from snowballing into the next segment
            condition_on_previous_text=False,
            # Whisper's own thresholds for dropping likely-silence segments
            no_speech_threshold=0.5,
            logprob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass

    segments = []
    for seg in result["segments"]:
        # Skip segments Whisper itself flagged as likely silence
        if seg.get("no_speech_prob", 0) > 0.5:
            continue
        # Skip segments with suspiciously high compression ratio (repetitive text)
        if seg.get("compression_ratio", 0) > 2.4:
            continue
        segments.append({
            "speaker_id": speaker_id,
            "speaker_name": speaker_name,
            "start": round(seg["start"], 3),
            "end": round(seg["end"], 3),
            "text": seg["text"].strip(),
            "words": [
                {"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
                for w in seg.get("words", [])
            ],
        })

    return _filter_hallucinations(segments)


def transcribe_all(speakers: list[dict], model_name: str, progress_callback=None) -> dict[str, list]:
    """Transcribe all speaker files. Returns {speaker_id: [segments]}."""
    transcripts = {}
    total = len(speakers)

    for i, speaker in enumerate(speakers):
        if progress_callback:
            progress_callback(i, total, speaker["name"])

        segments = transcribe_file(
            speaker["file_path"],
            speaker["id"],
            speaker["name"],
            model_name,
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

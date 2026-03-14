"""
processor.py — Whisper transcription and transcript merge
"""

import os
import shutil
import subprocess
import tempfile
import wave

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
        result = model.transcribe(audio_np, word_timestamps=True)
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass

    segments = []
    for seg in result["segments"]:
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

    return segments


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

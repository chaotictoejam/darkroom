"""
processor.py — Whisper transcription and transcript merge
"""

import whisper
import os


def transcribe_file(file_path: str, speaker_id: str, speaker_name: str, model_name: str = "base") -> list[dict]:
    """Transcribe a single video/audio file using Whisper. Returns list of segment dicts."""
    model = whisper.load_model(model_name)
    result = model.transcribe(str(file_path), word_timestamps=True)

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

"""
audio_engine.py — audio-specific FFmpeg filter fragments.

Kept separate from renderer.py's video compositing filter-graph code so
audio processing can grow independently — noise reduction, true filler-word
removal-with-crossfade, per-word volume leveling — without tangling into the
video overlay/crop/concat logic.
"""

LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11"


def normalize_audio_filter(input_label: str, output_label: str) -> str:
    """FFmpeg filter fragment that loudness-normalizes audio to -16 LUFS."""
    return f"[{input_label}]{LOUDNORM_FILTER}[{output_label}]"


def passthrough_audio_filter(input_label: str, output_label: str) -> str:
    """No-op audio filter fragment — used where normalization would be too slow (previews)."""
    return f"[{input_label}]anull[{output_label}]"

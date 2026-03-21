"""
editor.py — Claude API call + EDL generation
"""

import anthropic
import json
import os
import re

from processor import format_for_claude


_SYSTEM = (
    "You are an expert podcast video editor. "
    "You receive a transcript from a multi-camera podcast recording and return an Edit Decision List (EDL) as JSON. "
    "Return ONLY valid JSON — no prose, no markdown fences, no explanation. "
    "Start your response with { and end with }."
)

_PROMPT_TMPL = """\
You are editing a multi-camera podcast. Here is the full transcript:

SPEAKERS: {speakers}
TOTAL DURATION: {duration:.1f} seconds

TRANSCRIPT:
{transcript}

Create an Edit Decision List following these rules:
1. Remove filler words (um, uh, like, you know, so basically, I mean, right)
2. Remove silence gaps longer than 1.5 seconds
3. Remove off-topic tangents, restarts, and technical interruptions
4. NEVER cut mid-sentence — only cut at natural pause boundaries
5. Assign `camera` to the speaker who is actively talking in each segment — every time the active speaker changes, start a NEW segment. Do NOT lump multiple speakers into one long segment.
6. Use layout "single" for one speaker, "split" for two speakers talking together, "pip" for reaction shots
7. Identify the 3–5 best clips for Shorts/Reels. Each clip must be under 90 seconds but can be as short as 15 seconds if the moment is punchy and self-contained. Prioritise: strong hook, complete thought, no context needed. Give each a descriptive label.
8. Segments must be contiguous and together cover 0.0 to {duration:.1f} seconds
9. Available cameras: {cameras}
10. IMPORTANT: segments must be granular. A 60-second back-and-forth between two speakers should produce many short segments (5–20 seconds each), each on the correct camera. Never create a segment longer than ~30 seconds unless a single speaker talks uninterrupted for that long.

Return this exact JSON structure (no other text):
{{
  "segments": [
    {{
      "id": "seg_001",
      "start": 0.0,
      "end": 12.4,
      "keep": true,
      "camera": "A",
      "layout": "single",
      "reason": null
    }}
  ],
  "clips": [
    {{
      "id": "clip_001",
      "label": "Punchy opener",
      "start": 4.2,
      "end": 34.8,
      "reason": "Strong hook, no context needed"
    }},
    {{
      "id": "clip_002",
      "label": "Best story moment",
      "start": 210.0,
      "end": 285.5,
      "reason": "Complete thought, high energy"
    }}
  ]
}}
"""

_STRICT_SUFFIX = (
    "\n\nCRITICAL: Your response MUST start with {{ and end with }}. "
    "No markdown. No code fences. Raw JSON only."
)


def build_prompt(merged_transcript: list[dict], speakers: list[dict]) -> str:
    """Return the full user-facing prompt string (for copy-paste into Claude Code)."""
    transcript_text = format_for_claude(merged_transcript)
    duration = merged_transcript[-1]["end"] if merged_transcript else 0.0
    speaker_desc = ", ".join(f"{s['id']} ({s['name']})" for s in speakers)
    cameras = ", ".join(s["id"] for s in speakers)
    return _PROMPT_TMPL.format(
        speakers=speaker_desc,
        duration=duration,
        transcript=transcript_text,
        cameras=cameras,
    )


def generate_skip_edl(merged_transcript: list[dict], speakers: list[dict]) -> dict:
    """Return an EDL that keeps every transcript segment as-is (no AI edits)."""
    segments = []
    for i, seg in enumerate(merged_transcript):
        segments.append({
            "id": f"seg_{i + 1:03d}",
            "start": seg["start"],
            "end": seg["end"],
            "keep": True,
            "camera": seg["speaker_id"],
            "layout": "single",
            "reason": None,
        })
    return {"segments": segments, "clips": []}


def generate_edl(merged_transcript: list[dict], speakers: list[dict], retry: bool = False) -> dict:
    """Call Claude to produce an EDL from the merged transcript."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or api_key == "your_anthropic_api_key_here":
        raise ValueError("ANTHROPIC_API_KEY is not set in .env")

    client = anthropic.Anthropic(api_key=api_key)

    transcript_text = format_for_claude(merged_transcript)
    duration = merged_transcript[-1]["end"] if merged_transcript else 0.0
    speaker_desc = ", ".join(f"{s['id']} ({s['name']})" for s in speakers)
    cameras = ", ".join(s["id"] for s in speakers)

    prompt = _PROMPT_TMPL.format(
        speakers=speaker_desc,
        duration=duration,
        transcript=transcript_text,
        cameras=cameras,
    )
    if retry:
        prompt += _STRICT_SUFFIX

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=8192,
        system=_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text.strip()

    # Strip accidental markdown fences
    if raw.startswith("```"):
        m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw)
        if m:
            raw = m.group(1).strip()

    try:
        edl = json.loads(raw)
        validate_edl(edl, total_duration=duration)
        return edl
    except (json.JSONDecodeError, ValueError) as exc:
        if not retry:
            return generate_edl(merged_transcript, speakers, retry=True)
        raise ValueError(f"Claude returned invalid EDL after retry: {exc}\n\nRaw response (first 500 chars):\n{raw[:500]}")


def validate_edl(edl: dict, total_duration: float | None = None) -> None:
    """Raise ValueError if EDL is structurally or temporally invalid."""
    if not isinstance(edl, dict):
        raise ValueError("EDL root must be a JSON object")
    if "segments" not in edl:
        raise ValueError("EDL missing 'segments'")
    if "clips" not in edl:
        raise ValueError("EDL missing 'clips'")

    required_seg_fields = {"id", "start", "end", "keep", "camera", "layout"}
    segs = edl["segments"]
    for i, seg in enumerate(segs):
        missing = required_seg_fields - set(seg.keys())
        if missing:
            raise ValueError(f"Segment {i} missing fields: {missing}")
        if not isinstance(seg["keep"], bool):
            raise ValueError(f"Segment {i} 'keep' must be boolean")
        if seg["end"] <= seg["start"]:
            raise ValueError(
                f"{seg['id']}: end ({seg['end']}) must be > start ({seg['start']})"
            )

    # Contiguity: each segment must start where the previous one ended (±50 ms)
    _TOLERANCE = 0.05
    for i in range(1, len(segs)):
        prev, curr = segs[i - 1], segs[i]
        gap = curr["start"] - prev["end"]
        if abs(gap) > _TOLERANCE:
            raise ValueError(
                f"Segments not contiguous: {prev['id']} ends at {prev['end']} "
                f"but {curr['id']} starts at {curr['start']} (gap={gap:+.3f}s)"
            )

    if total_duration is not None and segs:
        tail_gap = abs(segs[-1]["end"] - total_duration)
        if tail_gap > _TOLERANCE:
            raise ValueError(
                f"Last segment ends at {segs[-1]['end']} but total duration is {total_duration}"
            )

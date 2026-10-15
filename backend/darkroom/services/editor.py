"""
editor.py — Claude EDL generation via Anthropic API or AWS Bedrock
"""

import json
import os
import re
import threading
import time
from typing import Callable

from .transcription import format_for_claude


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
2. Remove silence gaps longer than 1.5 seconds by covering them with a keep:false segment
3. Remove off-topic tangents, restarts, and technical interruptions
4. NEVER cut mid-sentence — only cut at natural pause boundaries
5. Assign `camera` to the speaker who is actively talking in each segment — every time the active speaker changes, start a NEW segment. Do NOT lump multiple speakers into one long segment.
6. Use layout "single" for one speaker, "split" for two speakers talking together, "pip" for reaction shots
7. Identify the 3–5 best clips for Shorts/Reels. Each clip must be under 90 seconds but can be as short as 15 seconds if the moment is punchy and self-contained. Prioritise: strong hook, complete thought, no context needed. Give each a descriptive label.
8. Segments must be contiguous (each starts where the previous one ends) and together cover 0.0 to {duration:.1f} seconds
9. Available cameras: {cameras}
10. With more than one camera, segments must be granular: a 60-second back-and-forth between two speakers should produce many short segments (5–20 seconds each), each on the correct camera. With a single camera, only start a new segment where something is cut — merge consecutive kept speech into one segment.
11. Transcript times are in seconds. All `start` and `end` values MUST be plain decimal numbers copied from the transcript (e.g. 79.26) — never arithmetic expressions.

Return compact JSON on a single line — no indentation, no line breaks, no other text. Omit "layout" when it is "single". Give a short "reason" (a few words) only on keep:false segments. Example:
{{"segments":[{{"start":0.0,"end":12.4,"keep":true,"camera":"A"}},{{"start":12.4,"end":15.1,"keep":false,"camera":"A","reason":"Restart"}}],"clips":[{{"label":"Punchy opener","start":4.2,"end":34.8,"reason":"Strong hook, no context needed"}}]}}
"""

_STRICT_SUFFIX = (
    "\n\nCRITICAL: Your response MUST start with { and end with }. "
    "No markdown. No code fences. Raw JSON only. "
    "All start/end values must be plain decimal numbers — no arithmetic expressions."
)

# Sonnet 4.6 allows up to 128K output tokens; streaming keeps long responses clear of HTTP timeouts.
_MAX_TOKENS = 64000


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


_ANTHROPIC_MODEL = "claude-sonnet-4-6"
_BEDROCK_BASE_MODEL = "anthropic.claude-sonnet-4-5-20250929-v1:0"


def _bedrock_credentials_found() -> bool:
    try:
        import boto3
        return boto3.Session().get_credentials() is not None
    except Exception:
        # boto3 missing, or e.g. `aws login` credentials without botocore[crt]
        return False


# Inference-profile prefixes and the geography each can process in
# (https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)
_PROFILE_GEOGRAPHIES = {
    "us": "the US",
    "us-gov": "AWS GovCloud (US)",
    "eu": "the EU",
    "apac": "Asia Pacific",
    "jp": "Japan",
    "au": "Australia",
    "ca": "Canada",
}

# Profiles used when the live lookup fails: only those confirmed with ListInferenceProfiles
# for _BEDROCK_BASE_MODEL (15 Oct 2026). There was no apac. or ca. profile for it.
_FALLBACK_PREFIXES = {"us", "eu", "jp", "au"}

# Models that only run with the account's data retention mode set to `aws_review`
# (https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)
_RETENTION_REQUIRED_MODELS = ("anthropic.claude-fable-5",)


def _region_geographies(region: str) -> list[str]:
    """Inference-profile prefixes that keep a request in `region`'s own geography, narrowest first."""
    if region.startswith("us-gov-"):
        return ["us-gov"]
    if region in ("ap-northeast-1", "ap-northeast-3"):
        return ["jp", "apac"]
    if region in ("ap-southeast-2", "ap-southeast-4"):
        return ["au", "apac"]
    for geo_prefix, profile in (("us-", "us"), ("eu-", "eu"), ("ap-", "apac"), ("ca-", "ca")):
        if region.startswith(geo_prefix):
            return [profile]
    return []


def _model_prefix(model: str) -> str:
    """The inference-profile prefix of a Bedrock model ID ("" for an in-region model ID)."""
    prefix = model.split(".", 1)[0] if "." in model else ""
    return prefix if prefix in _PROFILE_GEOGRAPHIES or prefix == "global" else ""


# ── Live Bedrock lookups (cached; they run while the Editor loads) ─────────────

_LOOKUP_TTL = 600
_LOOKUP_FAILURE_TTL = 60
_lookup_cache: dict[tuple, tuple[float, object]] = {}
_lookup_lock = threading.Lock()


def _bedrock_control_client(region: str):
    import boto3
    from botocore.config import Config
    # Short timeouts: this runs while the Editor loads, and may be offline
    config = Config(connect_timeout=3, read_timeout=5, retries={"max_attempts": 1})
    return boto3.client("bedrock", region_name=region, config=config)


def _cached(key: tuple, fetch: Callable[[], object]):
    """fetch()'s result for `key`, cached; a failure is cached briefly and re-raised."""
    now = time.monotonic()
    with _lookup_lock:
        hit = _lookup_cache.get(key)
    if hit and hit[0] > now:
        if isinstance(hit[1], Exception):
            raise hit[1]
        return hit[1]
    try:
        value = fetch()
    except Exception as exc:
        with _lookup_lock:
            _lookup_cache[key] = (now + _LOOKUP_FAILURE_TTL, exc)
        raise
    with _lookup_lock:
        _lookup_cache[key] = (now + _LOOKUP_TTL, value)
    return value


def _profile_prefixes(region: str, base_model: str) -> set[str]:
    """Prefixes of the AWS-defined inference profiles for `base_model` that `region` can call."""
    def _fetch() -> set[str]:
        client = _bedrock_control_client(region)
        prefixes: set[str] = set()
        token = None
        while True:
            kwargs = {"typeEquals": "SYSTEM_DEFINED", "maxResults": 1000}
            if token:
                kwargs["nextToken"] = token
            response = client.list_inference_profiles(**kwargs)
            for profile in response["inferenceProfileSummaries"]:
                prefix, _, model = profile["inferenceProfileId"].partition(".")
                if model == base_model:
                    prefixes.add(prefix)
            token = response.get("nextToken")
            if not token:
                return prefixes
    return _cached(("profiles", region, base_model), _fetch)


def _supports_in_region(region: str, base_model: str) -> bool:
    """Whether `base_model` can be called directly in `region`, without an inference profile."""
    def _fetch() -> bool:
        details = _bedrock_control_client(region).get_foundation_model(modelIdentifier=base_model)
        return "ON_DEMAND" in details["modelDetails"]["inferenceTypesSupported"]
    return _cached(("in_region", region, base_model), _fetch)


def _account_retention_mode(region: str) -> str:
    """The account's Bedrock data retention mode in `region` (raises if it can't be read)."""
    return _bedrock_control_client(region).get_account_data_retention()["mode"]


def _lookup_error(exc: Exception, permission: str) -> str:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    if code in ("AccessDeniedException", "AccessDenied", "UnauthorizedOperation"):
        return f"your AWS credentials lack {permission}"
    return str(exc) or type(exc).__name__


# ── Choosing and checking the Bedrock model ───────────────────────────────────

def _resolve_in_region(region: str, lookup: bool) -> tuple[str, str | None, list[str]]:
    model = _BEDROCK_BASE_MODEL
    if not lookup:
        return model, None, []
    try:
        if not _supports_in_region(region, model):
            return model, (
                f"{model} can't be called in-region in {region}, only through an inference profile. "
                f"Unset BEDROCK_IN_REGION to use the profile for {region}'s geography."
            ), []
    except Exception as exc:
        return model, None, [
            f"Couldn't check that {model} can be called in-region in {region} "
            f"({_lookup_error(exc, 'bedrock:GetFoundationModel')})."
        ]
    return model, None, []


def _resolve_bedrock_model(region: str, lookup: bool = True) -> tuple[str, str | None, list[str]]:
    """The model ID Analyse will use from `region`, why it's refused (or None), and warnings.

    BEDROCK_MODEL_ID wins. Otherwise the default model goes through the inference profile for
    `region`'s own geography, found with a live lookup (`lookup=False` skips AWS calls and uses
    the confirmed fallbacks). Never silently picks a profile in another geography.
    BEDROCK_IN_REGION=1 uses the plain model ID, so requests are processed in `region` only.
    """
    if model := os.getenv("BEDROCK_MODEL_ID"):
        return model, None, []
    if os.getenv("BEDROCK_IN_REGION") == "1":
        return _resolve_in_region(region, lookup)

    base = _BEDROCK_BASE_MODEL
    geographies = _region_geographies(region)
    warnings = []
    available = None
    if lookup:
        try:
            available = _profile_prefixes(region, base)
        except Exception as exc:
            warnings.append(
                f"Couldn't look up Bedrock inference profiles in {region} "
                f"({_lookup_error(exc, 'bedrock:ListInferenceProfiles')}); using Darkroom's built-in default."
            )

    if available is None:
        prefix = next((p for p in geographies if p in _FALLBACK_PREFIXES), None)
        if prefix is None:
            return base, (
                f"Darkroom doesn't know an inference profile for {base} in {region}'s geography. "
                "Set BEDROCK_MODEL_ID to a geographic (us., eu., …) model ID you accept."
            ), warnings
        return f"{prefix}.{base}", None, warnings

    prefix = next((p for p in geographies if p in available), None)
    if prefix is not None:
        return f"{prefix}.{base}", None, warnings
    others = sorted(p for p in available if p in _PROFILE_GEOGRAPHIES)
    if others:
        options = ", ".join(f"{p}.{base} ({_PROFILE_GEOGRAPHIES[p]})" for p in others)
        return base, (
            f"{base} has no inference profile for {region}'s geography. Available from {region}: "
            f"{options}. Set BEDROCK_MODEL_ID to one of them to accept processing there."
        ), warnings
    return base, (
        f"{base} has no inference profile for {region}'s geography, only a global one (refused). "
        f"Use another AWS_REGION, or set BEDROCK_MODEL_ID to a model available in {region}."
    ), warnings


def _allows_retention_models() -> bool:
    return os.getenv("BEDROCK_ALLOW_RETENTION_MODELS") == "1"


def _requires_retention(model: str) -> bool:
    return any(m in model for m in _RETENTION_REQUIRED_MODELS)


def _bedrock_refusal(model: str) -> str | None:
    """Why Darkroom won't send a transcript to `model`, or None if it may."""
    if _model_prefix(model) == "global":
        return (
            f"{model} is a global inference profile, which can be processed in any AWS region "
            "worldwide. Use a geographic (us., eu., …) or in-region model ID."
        )
    if _requires_retention(model) and not _allows_retention_models():
        return (
            f"{model} requires Bedrock data retention mode aws_review: AWS keeps every request for "
            "up to 30 days and staff may review flagged ones. Set BEDROCK_ALLOW_RETENTION_MODELS=1 "
            "to allow it, or use a model that supports zero retention."
        )
    return None


def _bedrock_choice(region: str, lookup: bool = True) -> tuple[str, str | None, list[str]]:
    """_resolve_bedrock_model, plus Darkroom's refusals (global profiles, retention-only models)."""
    model, blocked, warnings = _resolve_bedrock_model(region, lookup)
    return model, blocked or _bedrock_refusal(model), warnings


def _bedrock_detail(model: str, region: str) -> str:
    """Where Bedrock may process a request for `model`, called from `region`."""
    prefix = _model_prefix(model)
    if prefix == "global":
        return (
            "Global inference profile: may be processed in any AWS commercial region "
            "worldwide. Stays in AWS, not shared with Anthropic."
        )
    if prefix:
        return (
            f"Cross-Region inference profile: may be processed in other regions in "
            f"{_PROFILE_GEOGRAPHIES[prefix]}, not only {region}. Stays in AWS, not shared with Anthropic."
        )
    return f"Processed in {region} only. Stays in AWS, not shared with Anthropic."


def _geography_warning(model: str, region: str) -> str | None:
    """A warning when `model`'s profile processes outside `region`'s geography."""
    prefix = _model_prefix(model)
    geographies = _region_geographies(region)
    if not prefix or prefix == "global" or not geographies or prefix in geographies:
        return None
    # jp. and au. are narrower than apac., so either suits any Asia Pacific region
    if prefix in ("jp", "au") and "apac" in geographies:
        return None
    return (
        f"{model} is a profile for {_PROFILE_GEOGRAPHIES[prefix]} but AWS_REGION is {region}: "
        f"requests are processed in {_PROFILE_GEOGRAPHIES[prefix]}, outside {region}'s geography."
    )


def _retention_warnings(model: str, mode: str | None, region: str) -> list[str]:
    """What the Analyse confirmation should warn about, given the account's retention mode."""
    warnings = []
    if _requires_retention(model):
        warnings.append(
            f"{model} requires data retention mode aws_review: AWS keeps this transcript for up to "
            "30 days for abuse detection and staff may review it if flagged. It is not shared with Anthropic."
        )
    if mode is not None and mode != "none":
        warnings.append(
            f"Your account's Bedrock data retention mode in {region} is \"{mode}\", not \"none\", so "
            "AWS may store requests for models that allow it. Set it to none to guarantee nothing is kept."
        )
    return warnings


def ai_refusal() -> str | None:
    """Why Analyse must not run with the configured provider, or None (Bedrock lookups are cached)."""
    if os.getenv("AI_PROVIDER", "anthropic").lower() != "bedrock":
        return None
    return _bedrock_choice(os.getenv("AWS_REGION", "us-east-1"))[1]


def ai_status() -> dict:
    """Which AI provider Analyse will use, where the transcript goes, and whether it's set up."""
    provider = os.getenv("AI_PROVIDER", "anthropic").lower()
    if provider == "bedrock":
        region = os.getenv("AWS_REGION", "us-east-1")
        configured = _bedrock_credentials_found()
        # Without credentials the AWS lookups would only fail, so skip them
        model, blocked, warnings = _bedrock_choice(region, lookup=configured)
        detail = _bedrock_detail(model, region)
        mode = None

        if geography := _geography_warning(model, region):
            warnings.append(geography)
        if configured:
            try:
                mode = _account_retention_mode(region)
            except Exception as exc:
                warnings.append(
                    f"Couldn't check your account's Bedrock data retention mode in {region} "
                    f"({_lookup_error(exc, 'bedrock:GetAccountDataRetention')}). Make sure it is set to none."
                )
        if mode == "none" and not _requires_retention(model):
            detail += " Not stored: your account's data retention mode is none."
        warnings += _retention_warnings(model, mode, region)

        return {
            "provider": "bedrock",
            "model": model,
            "destination": f"Bedrock in your AWS account ({region})",
            "detail": detail,
            "configured": configured,
            "retention_mode": mode,
            "warnings": warnings,
            "blocked": blocked,
        }
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    return {
        "provider": "anthropic",
        "model": _ANTHROPIC_MODEL,
        "destination": "Anthropic's API (third party)",
        "detail": "Leaves this computer and is handled by Anthropic under its API data policy.",
        "configured": bool(api_key and api_key != "your_anthropic_api_key_here"),
        "retention_mode": None,
        "warnings": [],
        "blocked": None,
    }


def _call_anthropic(prompt: str, on_text: Callable[[str], None]) -> tuple[str, str | None]:
    import anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set in .env")
    client = anthropic.Anthropic(api_key=api_key)
    with client.messages.stream(
        model=_ANTHROPIC_MODEL,
        max_tokens=_MAX_TOKENS,
        system=_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        for text in stream.text_stream:
            on_text(text)
        message = stream.get_final_message()
    text = "".join(block.text for block in message.content if block.type == "text")
    return text.strip(), message.stop_reason


def _call_bedrock(prompt: str, on_text: Callable[[str], None]) -> tuple[str, str | None]:
    import boto3
    region = os.getenv("AWS_REGION", "us-east-1")
    model_id, refusal, _ = _bedrock_choice(region)
    if refusal:
        raise ValueError(refusal)
    client = boto3.client("bedrock-runtime", region_name=region)
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": _MAX_TOKENS,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
    })
    response = client.invoke_model_with_response_stream(
        modelId=model_id,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    parts: list[str] = []
    stop_reason = None
    for event in response["body"]:
        chunk = event.get("chunk")
        if not chunk:
            continue
        data = json.loads(chunk["bytes"])
        if data["type"] == "content_block_delta" and data["delta"].get("type") == "text_delta":
            parts.append(data["delta"]["text"])
            on_text(data["delta"]["text"])
        elif data["type"] == "message_delta":
            stop_reason = data["delta"].get("stop_reason") or stop_reason
    return "".join(parts).strip(), stop_reason


def _normalise_edl(edl: dict) -> None:
    """Fill in the fields the prompt lets Claude leave out (ids, default layout, reasons)."""
    for i, seg in enumerate(edl.get("segments", [])):
        seg.setdefault("id", f"seg_{i + 1:03d}")
        seg.setdefault("layout", "single")
        seg.setdefault("reason", None)
    for i, clip in enumerate(edl.get("clips", [])):
        clip.setdefault("id", f"clip_{i + 1:03d}")
        clip.setdefault("reason", None)


def _number_ids(edl: dict) -> None:
    for i, seg in enumerate(edl["segments"]):
        seg["id"] = f"seg_{i + 1:03d}"
    for i, clip in enumerate(edl["clips"]):
        clip["id"] = f"clip_{i + 1:03d}"


def generate_edl(
    merged_transcript: list[dict],
    speakers: list[dict],
    retry: bool = False,
    on_progress: Callable[[int], None] | None = None,
) -> dict:
    """Call Claude (via Anthropic API or Bedrock) to produce an EDL from the merged transcript.

    `on_progress` is called with the number of segments written so far while the response streams.
    """
    provider = os.getenv("AI_PROVIDER", "anthropic").lower()

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

    marker = '"start"'
    seen = {"tail": "", "count": 0}

    def _on_text(text: str) -> None:
        # Count segment starts as they stream; the tail catches a marker split across chunks
        window = seen["tail"] + text
        seen["count"] += window.count(marker)
        seen["tail"] = window[-(len(marker) - 1):]
        if on_progress:
            on_progress(seen["count"])

    if provider == "bedrock":
        raw, stop_reason = _call_bedrock(prompt, _on_text)
    else:
        raw, stop_reason = _call_anthropic(prompt, _on_text)

    if stop_reason == "max_tokens":
        # Retrying the same request would be cut off again, so fail with a clear message
        raise ValueError(
            f"Claude's edit list was cut off at the {_MAX_TOKENS}-token output limit. "
            "The recording may be too long to analyse in one pass."
        )

    # Strip accidental markdown fences
    if raw.startswith("```"):
        m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw)
        if m:
            raw = m.group(1).strip()

    try:
        edl = json.loads(raw)
        if isinstance(edl, dict):
            _normalise_edl(edl)
        validate_edl(edl, total_duration=duration)
        _number_ids(edl)
        return edl
    except (json.JSONDecodeError, ValueError) as exc:
        if not retry:
            return generate_edl(merged_transcript, speakers, retry=True, on_progress=on_progress)
        raise ValueError(f"Claude returned invalid EDL after retry: {exc}\n\nRaw response (first 500 chars):\n{raw[:500]}")


def validate_edl(edl: dict, total_duration: float | None = None) -> None:
    """Raise ValueError if EDL is structurally or temporally invalid; fixes small gaps in place."""
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
        if seg["end"] < seg["start"]:
            seg["start"], seg["end"] = seg["end"], seg["start"]
        if seg["end"] == seg["start"]:
            raise ValueError(f"{seg['id']}: start and end are equal ({seg['start']}), segment has zero duration")

    # Contiguity: drop backward keep=false placeholders, snap small gaps, reject large overlaps,
    # and cover large gaps (time Claude left out) with keep=false segments
    _SNAP_TOLERANCE = 2.0
    if not segs:
        return
    if total_duration is not None and segs[0]["start"] > _SNAP_TOLERANCE:
        segs.insert(0, _gap_segment(0.0, segs[0]["start"], segs[0]))
    out = [segs[0]]
    for curr in segs[1:]:
        prev = out[-1]
        gap = curr["start"] - prev["end"]
        if gap < -_SNAP_TOLERANCE:
            # Segment goes backward in time — drop it if it's a discarded placeholder
            if not curr["keep"]:
                continue
            raise ValueError(
                f"Segments not contiguous: {prev['id']} ends at {prev['end']} "
                f"but {curr['id']} starts at {curr['start']} (gap={gap:+.3f}s)"
            )
        if gap > _SNAP_TOLERANCE:
            out.append(_gap_segment(prev["end"], curr["start"], prev))
        elif gap != 0:
            curr["start"] = prev["end"]
        out.append(curr)

    if total_duration is not None:
        tail_gap = total_duration - out[-1]["end"]
        if tail_gap < -_SNAP_TOLERANCE:
            raise ValueError(
                f"Last segment ends at {out[-1]['end']} but total duration is {total_duration}"
            )
        if tail_gap > _SNAP_TOLERANCE:
            out.append(_gap_segment(out[-1]["end"], total_duration, out[-1]))
    edl["segments"] = out


def _gap_segment(start: float, end: float, neighbour: dict) -> dict:
    return {
        "id": f"{neighbour['id']}_gap",
        "start": start,
        "end": end,
        "keep": False,
        "camera": neighbour["camera"],
        "layout": "single",
        "reason": "Left out of the edit",
    }

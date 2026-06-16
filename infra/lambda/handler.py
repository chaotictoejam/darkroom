"""
Async Lambda handler — calls Claude on AWS Bedrock and returns a raw EDL JSON string.

Event schema:
  prompt  str   Fully-formatted EDL generation prompt
  retry   bool  (optional) If true, appends the strict-JSON suffix before calling Bedrock

Response schema:
  edl_raw  str  Raw JSON string returned by the model (caller is responsible for parsing)
"""

import json
import os
import re

import boto3

_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")

_SYSTEM = (
    "You are an expert podcast video editor. "
    "You receive a transcript from a multi-camera podcast recording and return an Edit Decision List (EDL) as JSON. "
    "Return ONLY valid JSON — no prose, no markdown fences, no explanation. "
    "Start your response with { and end with }."
)

_STRICT_SUFFIX = (
    "\n\nCRITICAL: Your response MUST start with { and end with }. "
    "No markdown. No code fences. Raw JSON only. "
    "All start/end values must be plain decimal numbers — no arithmetic expressions."
)

_bedrock = boto3.client("bedrock-runtime")


async def handler(event: dict, context) -> dict:
    prompt: str = event["prompt"]
    if event.get("retry"):
        prompt += _STRICT_SUFFIX

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8192,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
    })

    response = _bedrock.invoke_model(
        modelId=_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )

    result = json.loads(response["body"].read())
    raw: str = result["content"][0]["text"].strip()

    if raw.startswith("```"):
        m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw)
        if m:
            raw = m.group(1).strip()

    return {"edl_raw": raw}

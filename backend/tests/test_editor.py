"""EDL generation: streamed provider responses, compact output, gap handling, truncation."""
import json

import pytest

from darkroom.services import editor

_TRANSCRIPT = [
    {"start": 0.0, "end": 10.0, "speaker_id": "A", "speaker_name": "Joanne", "text": "Hello."},
    {"start": 13.0, "end": 30.0, "speaker_id": "A", "speaker_name": "Joanne", "text": "Um, so, today."},
]
_SPEAKERS = [{"id": "A", "name": "Joanne"}]


class _FakeBedrock:
    """Stands in for boto3's bedrock-runtime client; streams `text` in small chunks."""

    def __init__(self, responses: list[tuple[str, str]]):
        self.responses = responses
        self.calls = 0

    def invoke_model_with_response_stream(self, **kwargs):
        text, stop_reason = self.responses[self.calls]
        self.calls += 1
        events = [{"type": "message_start"}]
        events += [
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text[i:i + 7]}}
            for i in range(0, len(text), 7)
        ]
        events.append({"type": "message_delta", "delta": {"stop_reason": stop_reason}})
        return {"body": [{"chunk": {"bytes": json.dumps(e).encode()}} for e in events]}


@pytest.fixture
def bedrock(monkeypatch):
    boto3 = pytest.importorskip("boto3")
    fake = _FakeBedrock([])
    monkeypatch.setenv("AI_PROVIDER", "bedrock")
    monkeypatch.setattr(boto3, "client", lambda *a, **k: fake)
    return fake


def test_compact_edl_is_normalised_and_gaps_become_cuts(bedrock):
    # Claude leaves out 10–13 s (a silence) instead of covering it, as in the failing run
    bedrock.responses = [(
        '{"segments":[{"start":0.0,"end":10.0,"keep":true,"camera":"A"},'
        '{"start":13.0,"end":30.0,"keep":true,"camera":"A"}],'
        '"clips":[{"label":"Opener","start":0.0,"end":20.0}]}',
        "end_turn",
    )]
    counts = []
    edl = editor.generate_edl(_TRANSCRIPT, _SPEAKERS, on_progress=counts.append)

    assert bedrock.calls == 1
    assert [(s["id"], s["start"], s["end"], s["keep"]) for s in edl["segments"]] == [
        ("seg_001", 0.0, 10.0, True),
        ("seg_002", 10.0, 13.0, False),
        ("seg_003", 13.0, 30.0, True),
    ]
    assert all(s["layout"] == "single" for s in edl["segments"])
    assert edl["clips"][0]["id"] == "clip_001"
    assert counts[-1] == 3  # two segment starts plus the clip's


def test_truncated_response_fails_without_retrying(bedrock):
    bedrock.responses = [('{"segments":[{"start":0.0,"end":10.0,', "max_tokens")]
    with pytest.raises(ValueError, match="cut off"):
        editor.generate_edl(_TRANSCRIPT, _SPEAKERS)
    assert bedrock.calls == 1


def test_invalid_json_is_retried_once(bedrock):
    good = '{"segments":[{"start":0.0,"end":30.0,"keep":true,"camera":"A"}],"clips":[]}'
    bedrock.responses = [("not json", "end_turn"), (good, "end_turn")]
    edl = editor.generate_edl(_TRANSCRIPT, _SPEAKERS)
    assert bedrock.calls == 2
    assert len(edl["segments"]) == 1


def test_validate_edl_drops_backward_placeholder_and_compares_with_kept_segment():
    edl = {
        "segments": [
            {"id": "a", "start": 0.0, "end": 10.0, "keep": True, "camera": "A", "layout": "single"},
            {"id": "b", "start": 2.0, "end": 4.0, "keep": False, "camera": "A", "layout": "single"},
            {"id": "c", "start": 10.5, "end": 30.0, "keep": True, "camera": "A", "layout": "single"},
        ],
        "clips": [],
    }
    editor.validate_edl(edl, total_duration=30.0)
    assert [(s["id"], s["start"]) for s in edl["segments"]] == [("a", 0.0), ("c", 10.0)]


def test_validate_edl_rejects_large_overlap_of_kept_segments():
    edl = {
        "segments": [
            {"id": "a", "start": 0.0, "end": 10.0, "keep": True, "camera": "A", "layout": "single"},
            {"id": "b", "start": 5.0, "end": 30.0, "keep": True, "camera": "A", "layout": "single"},
        ],
        "clips": [],
    }
    with pytest.raises(ValueError, match="not contiguous"):
        editor.validate_edl(edl, total_duration=30.0)


def test_transcript_times_are_given_in_seconds():
    text = editor.build_prompt(_TRANSCRIPT, _SPEAKERS)
    assert "[13.00 - 30.00] Joanne: Um, so, today." in text


# ── ai_status: where Analyse sends the transcript ─────────────────────────────


@pytest.fixture
def bedrock_env(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "bedrock")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    monkeypatch.setattr(editor, "_bedrock_credentials_found", lambda: True)
    return monkeypatch


def test_ai_status_anthropic_is_labelled_third_party(monkeypatch):
    monkeypatch.delenv("AI_PROVIDER", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    status = editor.ai_status()
    assert status["provider"] == "anthropic"
    assert status["configured"] is True
    assert "third party" in status["destination"]
    assert "Leaves this computer" in status["detail"]


def test_ai_status_anthropic_placeholder_key_is_not_configured(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "your_anthropic_api_key_here")
    assert editor.ai_status()["configured"] is False


def test_ai_status_bedrock_names_account_and_region(bedrock_env):
    bedrock_env.setenv("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-5-20250929-v1:0")
    status = editor.ai_status()
    assert status["provider"] == "bedrock"
    assert status["configured"] is True
    assert status["destination"] == "Bedrock in your AWS account (eu-west-1)"
    assert status["detail"].startswith("Processed in eu-west-1 only.")


@pytest.mark.parametrize("prefix, geography", [
    ("us", "the US"),
    ("eu", "the EU"),
    ("apac", "Asia Pacific"),
    ("us-gov", "AWS GovCloud (US)"),
])
def test_ai_status_bedrock_geographic_profile_warns_other_regions(bedrock_env, prefix, geography):
    bedrock_env.setenv("BEDROCK_MODEL_ID", f"{prefix}.anthropic.claude-sonnet-4-5-20250929-v1:0")
    detail = editor.ai_status()["detail"]
    assert f"other regions in {geography}" in detail
    assert "not only eu-west-1" in detail


def test_ai_status_bedrock_global_profile_says_worldwide(bedrock_env):
    bedrock_env.setenv("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-5-20250929-v1:0")
    assert "any AWS commercial region worldwide" in editor.ai_status()["detail"]


def test_ai_status_bedrock_default_model_is_us_profile(bedrock_env):
    bedrock_env.delenv("BEDROCK_MODEL_ID", raising=False)
    status = editor.ai_status()
    assert status["model"].startswith("us.")
    assert "other regions in the US" in status["detail"]


def test_ai_status_bedrock_without_credentials_is_not_configured(bedrock_env):
    bedrock_env.setattr(editor, "_bedrock_credentials_found", lambda: False)
    assert editor.ai_status()["configured"] is False

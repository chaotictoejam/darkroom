"""EDL generation: streamed provider responses, compact output, gap handling, truncation."""
import json

import pytest

from darkroom.services import editor

_TRANSCRIPT = [
    {"start": 0.0, "end": 10.0, "speaker_id": "A", "speaker_name": "Joanne", "text": "Hello."},
    {"start": 13.0, "end": 30.0, "speaker_id": "A", "speaker_name": "Joanne", "text": "Um, so, today."},
]
_SPEAKERS = [{"id": "A", "name": "Joanne"}]


def _raise(exc: Exception):
    raise exc


def _client_error(code: str, operation: str):
    from botocore.exceptions import ClientError
    return ClientError({"Error": {"Code": code, "Message": "nope"}}, operation)


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
    monkeypatch.setattr(editor, "_profile_prefixes", lambda region, model: {"us", "eu", "global"})
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


# Inference profiles for Sonnet 4.5 per region, from ListInferenceProfiles on 15 Oct 2026
_PROFILES = {
    "us-east-1": {"us", "global"},
    "eu-west-1": {"eu", "global"},
    "ap-northeast-1": {"jp", "global"},
    "ap-southeast-2": {"au", "global"},
    "ap-south-1": {"global"},
    "ca-central-1": {"us", "global"},
    "sa-east-1": {"global"},
}


@pytest.fixture
def bedrock_env(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "bedrock")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    monkeypatch.delenv("BEDROCK_MODEL_ID", raising=False)
    monkeypatch.delenv("BEDROCK_IN_REGION", raising=False)
    monkeypatch.delenv("BEDROCK_ALLOW_RETENTION_MODELS", raising=False)
    monkeypatch.setattr(editor, "_bedrock_credentials_found", lambda: True)
    monkeypatch.setattr(editor, "_account_retention_mode", lambda region: "none")
    monkeypatch.setattr(editor, "_profile_prefixes", lambda region, model: _PROFILES[region])
    monkeypatch.setattr(editor, "_supports_in_region", lambda region, model: False)
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


def test_ai_status_bedrock_global_profile_is_blocked(bedrock_env):
    bedrock_env.setenv("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-5-20250929-v1:0")
    status = editor.ai_status()
    assert "any AWS commercial region worldwide" in status["detail"]
    assert "global inference profile" in status["blocked"]
    assert editor.ai_refusal() == status["blocked"]


@pytest.mark.parametrize("region, prefix", [
    ("us-east-1", "us."),
    ("eu-west-1", "eu."),
    ("ap-northeast-1", "jp."),
    ("ap-southeast-2", "au."),
])
def test_ai_status_bedrock_default_model_uses_regions_profile(bedrock_env, region, prefix):
    bedrock_env.setenv("AWS_REGION", region)
    status = editor.ai_status()
    assert status["model"] == prefix + editor._BEDROCK_BASE_MODEL
    assert status["warnings"] == []
    assert status["blocked"] is None


def test_default_model_never_falls_back_to_another_geography(bedrock_env):
    bedrock_env.setenv("AWS_REGION", "ca-central-1")
    blocked = editor.ai_status()["blocked"]
    assert "no inference profile for ca-central-1's geography" in blocked
    assert f"us.{editor._BEDROCK_BASE_MODEL} (the US)" in blocked
    assert editor.ai_refusal() == blocked


@pytest.mark.parametrize("region", ["ap-south-1", "sa-east-1"])
def test_default_model_with_only_global_profile_is_blocked(bedrock_env, region):
    bedrock_env.setenv("AWS_REGION", region)
    assert "only a global one (refused)" in editor.ai_status()["blocked"]


def test_failed_profile_lookup_uses_confirmed_fallback_with_warning(bedrock_env):
    def _denied(region, model):
        raise _client_error("AccessDeniedException", "ListInferenceProfiles")

    bedrock_env.setattr(editor, "_profile_prefixes", _denied)
    status = editor.ai_status()
    assert status["model"] == "eu." + editor._BEDROCK_BASE_MODEL
    assert status["blocked"] is None
    assert any("lack bedrock:ListInferenceProfiles" in w for w in status["warnings"])


def test_failed_profile_lookup_without_confirmed_fallback_is_blocked(bedrock_env):
    bedrock_env.setenv("AWS_REGION", "ca-central-1")
    bedrock_env.setattr(editor, "_profile_prefixes", lambda region, model: _raise(OSError("offline")))
    assert "Set BEDROCK_MODEL_ID" in editor.ai_status()["blocked"]


def test_ai_status_without_credentials_makes_no_lookups(bedrock_env):
    bedrock_env.setattr(editor, "_bedrock_credentials_found", lambda: False)
    bedrock_env.setattr(editor, "_profile_prefixes", lambda region, model: _raise(AssertionError("looked up")))
    status = editor.ai_status()
    assert status["configured"] is False
    assert status["model"] == "eu." + editor._BEDROCK_BASE_MODEL


def test_explicit_model_id_skips_profile_lookup(bedrock_env):
    bedrock_env.setenv("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
    bedrock_env.setattr(editor, "_profile_prefixes", lambda region, model: _raise(AssertionError("looked up")))
    assert editor.ai_status()["model"] == "us.anthropic.claude-sonnet-4-6"


def test_in_region_unsupported_model_is_blocked(bedrock_env):
    bedrock_env.setenv("BEDROCK_IN_REGION", "1")
    status = editor.ai_status()
    assert status["model"] == editor._BEDROCK_BASE_MODEL
    assert "can't be called in-region in eu-west-1" in status["blocked"]


def test_in_region_supported_model_processes_in_region_only(bedrock_env):
    bedrock_env.setenv("BEDROCK_IN_REGION", "1")
    bedrock_env.setattr(editor, "_supports_in_region", lambda region, model: True)
    status = editor.ai_status()
    assert status["blocked"] is None
    assert status["detail"].startswith("Processed in eu-west-1 only.")


def test_in_region_check_failure_warns(bedrock_env):
    bedrock_env.setenv("BEDROCK_IN_REGION", "1")
    bedrock_env.setattr(editor, "_supports_in_region", lambda region, model: _raise(OSError("offline")))
    status = editor.ai_status()
    assert status["blocked"] is None
    assert any("Couldn't check" in w and "in-region" in w for w in status["warnings"])


def test_ai_status_bedrock_profile_outside_region_geography_warns(bedrock_env):
    bedrock_env.setenv("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
    assert any("outside eu-west-1's geography" in w for w in editor.ai_status()["warnings"])


def test_ai_status_bedrock_without_credentials_is_not_configured(bedrock_env):
    bedrock_env.setattr(editor, "_bedrock_credentials_found", lambda: False)
    assert editor.ai_status()["configured"] is False


# ── Bedrock lock-down: retention mode, retention-only models ──────────────────

def test_ai_status_bedrock_retention_none_says_not_stored(bedrock_env):
    status = editor.ai_status()
    assert status["retention_mode"] == "none"
    assert status["detail"].endswith("Not stored: your account's data retention mode is none.")
    assert status["warnings"] == []
    assert status["blocked"] is None


@pytest.mark.parametrize("mode", ["default", "aws_review", "provider_data_share", "inherit"])
def test_ai_status_bedrock_other_retention_mode_warns_without_blocking(bedrock_env, mode):
    bedrock_env.setattr(editor, "_account_retention_mode", lambda region: mode)
    status = editor.ai_status()
    assert status["retention_mode"] == mode
    assert "Not stored" not in status["detail"]
    assert any(f'"{mode}", not "none"' in w for w in status["warnings"])
    assert status["blocked"] is None


def test_ai_status_bedrock_failed_retention_check_warns(bedrock_env):
    pytest.importorskip("botocore")

    def _denied(region):
        raise _client_error("AccessDeniedException", "GetAccountDataRetention")

    bedrock_env.setattr(editor, "_account_retention_mode", _denied)
    status = editor.ai_status()
    assert status["retention_mode"] is None
    assert "Not stored" not in status["detail"]
    assert any("lack bedrock:GetAccountDataRetention" in w for w in status["warnings"])
    assert status["blocked"] is None


def test_ai_status_bedrock_without_credentials_skips_retention_check(bedrock_env):
    bedrock_env.setattr(editor, "_bedrock_credentials_found", lambda: False)

    def _unexpected(region):
        raise AssertionError("retention checked without credentials")

    bedrock_env.setattr(editor, "_account_retention_mode", _unexpected)
    assert editor.ai_status()["retention_mode"] is None


@pytest.mark.parametrize("model", [
    "us.anthropic.claude-fable-5-v1:0",
    "eu.anthropic.claude-fable-5-1-v1:0",
])
def test_retention_only_models_are_refused_by_default(bedrock_env, model):
    bedrock_env.setenv("BEDROCK_MODEL_ID", model)
    status = editor.ai_status()
    assert "BEDROCK_ALLOW_RETENTION_MODELS=1" in status["blocked"]
    assert editor.ai_refusal() == status["blocked"]


def test_retention_only_model_allowed_with_flag_warns(bedrock_env):
    bedrock_env.setenv("BEDROCK_MODEL_ID", "eu.anthropic.claude-fable-5-1-v1:0")
    bedrock_env.setenv("BEDROCK_ALLOW_RETENTION_MODELS", "1")
    status = editor.ai_status()
    assert status["blocked"] is None
    assert "Not stored" not in status["detail"]
    assert any("up to 30 days" in w for w in status["warnings"])


def test_refused_model_is_never_called(bedrock, monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-5-20250929-v1:0")
    with pytest.raises(ValueError, match="global inference profile"):
        editor.generate_edl(_TRANSCRIPT, _SPEAKERS)
    assert bedrock.calls == 0


def test_ai_refusal_ignores_other_providers(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "anthropic")
    monkeypatch.setenv("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-5-20250929-v1:0")
    assert editor.ai_refusal() is None


# ── Live lookups: parsing and caching ─────────────────────────────────────────

class _FakeControl:
    """Stands in for boto3's bedrock client: two pages of inference profiles."""

    def __init__(self):
        self.calls = 0

    def list_inference_profiles(self, **kwargs):
        self.calls += 1
        if "nextToken" not in kwargs:
            return {"inferenceProfileSummaries": [
                {"inferenceProfileId": f"us.{editor._BEDROCK_BASE_MODEL}"},
                {"inferenceProfileId": "us.anthropic.claude-sonnet-4-6"},
            ], "nextToken": "page2"}
        return {"inferenceProfileSummaries": [{"inferenceProfileId": f"global.{editor._BEDROCK_BASE_MODEL}"}]}


def test_profile_prefixes_reads_every_page_and_is_cached(monkeypatch):
    fake = _FakeControl()
    monkeypatch.setattr(editor, "_bedrock_control_client", lambda region: fake)
    monkeypatch.setattr(editor, "_lookup_cache", {})
    assert editor._profile_prefixes("us-east-1", editor._BEDROCK_BASE_MODEL) == {"us", "global"}
    assert editor._profile_prefixes("us-east-1", editor._BEDROCK_BASE_MODEL) == {"us", "global"}
    assert fake.calls == 2  # one lookup, two pages


def test_failed_lookup_is_cached_briefly(monkeypatch):
    calls = []

    def _fetch():
        calls.append(1)
        raise OSError("offline")

    monkeypatch.setattr(editor, "_lookup_cache", {})
    for _ in range(2):
        with pytest.raises(OSError):
            editor._cached(("test",), _fetch)
    assert len(calls) == 1

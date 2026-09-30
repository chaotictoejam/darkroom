"""
transcription_aws.py — Amazon Transcribe adapter.

Produces output in the exact same shape transcription.transcribe_file() does
(list[{speaker_id, speaker_name, start, end, text, words:[{word,start,end}]}]),
so nothing downstream — editor.py's prompt builder, renderer.py's subtitle/
camera-switching logic, the frontend transcript components — needs to know or
care which engine produced a given project's transcript.

Requires boto3 (installed via the `aws` extra) and:
  TRANSCRIBE_S3_BUCKET — scratch bucket for uploaded audio + job output
  AWS_REGION           — defaults to us-east-1, same as the Bedrock path
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid

from .aws_errors import AWSCredentialsError, credentials_message, find_credential_error

logger = logging.getLogger(__name__)

# Amazon Transcribe wants BCP-47 codes; Darkroom's language picker (see
# Setup.tsx's LANGUAGES list) uses the same short ISO codes faster-whisper does.
_LANGUAGE_MAP = {
    "en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "it": "it-IT",
    "pt": "pt-BR", "nl": "nl-NL", "pl": "pl-PL", "ru": "ru-RU", "zh": "zh-CN",
    "ja": "ja-JP", "ko": "ko-KR", "ar": "ar-SA", "hi": "hi-IN",
}

_POLL_INTERVAL_SECONDS = 5
_SENTENCE_END = (".", "!", "?")
_PAUSE_GAP_SECONDS = 0.7


def _bcp47(language: str | None) -> str:
    return _LANGUAGE_MAP.get((language or "en").lower(), "en-US")


def _check_credentials(region: str) -> None:
    """Fail fast on missing/expired credentials, before spending time extracting audio."""
    import boto3
    try:
        boto3.client("sts", region_name=region).get_caller_identity()
    except Exception as exc:
        cred = find_credential_error(exc)
        if cred:
            raise AWSCredentialsError(credentials_message("Amazon Transcribe", cred)) from exc
        raise


def _extract_audio_flac(file_path: str) -> str:
    """Extract mono 16kHz FLAC (a format Transcribe accepts directly) to a temp file."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not on your PATH — required to prepare audio for Transcribe.")
    tmp = tempfile.mktemp(suffix=".flac")
    cmd = ["ffmpeg", "-y", "-nostdin", "-i", file_path, "-ac", "1", "-ar", "16000", "-f", "flac", tmp]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed:\n{result.stderr.decode(errors='replace')}")
    return tmp


def _map_transcribe_result(result: dict, speaker_id: str, speaker_name: str) -> list[dict]:
    """Map Amazon Transcribe's JSON output into transcribe_file()'s segment/word shape."""
    items = result.get("results", {}).get("items", [])

    words: list[dict] = []
    for item in items:
        alt = item["alternatives"][0]
        text = alt["content"]
        if item["type"] == "punctuation":
            # Attach trailing punctuation to the previous word rather than
            # emitting it as its own zero-duration word.
            if words:
                words[-1]["word"] = words[-1]["word"] + text
            continue
        words.append({
            "word": " " + text,
            "start": round(float(item["start_time"]), 3),
            "end": round(float(item["end_time"]), 3),
        })

    if not words:
        return []

    # Transcribe returns a flat word stream with no segment boundaries — group
    # into segments on sentence-ending punctuation or a >0.7s pause, mirroring
    # the natural chunking Whisper already produces.
    segments: list[list[dict]] = []
    current: list[dict] = [words[0]]
    for prev, w in zip(words, words[1:]):
        gap = w["start"] - prev["end"]
        ends_sentence = prev["word"].rstrip().endswith(_SENTENCE_END)
        if gap > _PAUSE_GAP_SECONDS or ends_sentence:
            segments.append(current)
            current = []
        current.append(w)
    if current:
        segments.append(current)

    return [
        {
            "speaker_id": speaker_id,
            "speaker_name": speaker_name,
            "start": seg[0]["start"],
            "end": seg[-1]["end"],
            "text": "".join(w["word"] for w in seg).strip(),
            "words": seg,
        }
        for seg in segments
    ]


def transcribe_file_aws(
    file_path: str,
    speaker_id: str,
    speaker_name: str,
    language: str | None = None,
    progress_callback=None,
) -> list[dict]:
    """Transcribe a single file via Amazon Transcribe. Returns transcribe_file()'s shape."""
    import boto3

    bucket = os.getenv("TRANSCRIBE_S3_BUCKET")
    if not bucket:
        raise ValueError(
            "TRANSCRIBE_S3_BUCKET is not set — required when TRANSCRIBE_PROVIDER=aws. "
            "Deploy infra/ (cdk deploy) to create one, or point at your own bucket."
        )
    region = os.getenv("AWS_REGION", "us-east-1")

    s3 = boto3.client("s3", region_name=region)
    transcribe = boto3.client("transcribe", region_name=region)

    audio_path = _extract_audio_flac(file_path)
    key = f"darkroom-transcribe/{uuid.uuid4().hex}.flac"
    job_name = f"darkroom-{uuid.uuid4().hex}"
    job_started = False

    try:
        s3.upload_file(audio_path, bucket, key)
        if progress_callback:
            progress_callback(0.1)

        transcribe.start_transcription_job(
            TranscriptionJobName=job_name,
            Media={"MediaFileUri": f"s3://{bucket}/{key}"},
            MediaFormat="flac",
            LanguageCode=_bcp47(language),
        )
        job_started = True

        while True:
            resp = transcribe.get_transcription_job(TranscriptionJobName=job_name)
            job = resp["TranscriptionJob"]
            status = job["TranscriptionJobStatus"]
            if status == "COMPLETED":
                break
            if status == "FAILED":
                raise RuntimeError(f"Transcribe job failed: {job.get('FailureReason', 'unknown reason')}")
            if progress_callback:
                progress_callback(0.5)
            time.sleep(_POLL_INTERVAL_SECONDS)

        transcript_uri = job["Transcript"]["TranscriptFileUri"]
        with urllib.request.urlopen(transcript_uri) as f:
            result = json.load(f)

        if progress_callback:
            progress_callback(0.95)

        return _map_transcribe_result(result, speaker_id, speaker_name)
    except Exception as exc:
        cred = find_credential_error(exc)
        if not cred:
            raise
        msg = credentials_message("Amazon Transcribe", cred)
        if job_started:
            # Credentials expired mid-job (long episodes can outlast an SSO session):
            # AWS keeps running — and billing — the job even though we've lost track of it.
            msg += (
                f"\n\nTranscribe job '{job_name}' had already started and may still finish "
                f"(and be billed) — check the Amazon Transcribe console in {region}. "
                f"The uploaded audio (s3://{bucket}/{key}) is removed by the bucket's 1-day lifecycle rule."
            )
        raise AWSCredentialsError(msg) from exc
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass
        try:
            s3.delete_object(Bucket=bucket, Key=key)
        except Exception as exc:
            logger.warning("Couldn't delete s3://%s/%s: %s", bucket, key, exc)
        if job_started:
            try:
                transcribe.delete_transcription_job(TranscriptionJobName=job_name)
            except Exception as exc:
                logger.warning("Couldn't delete Transcribe job %s: %s", job_name, exc)


def transcribe_all_aws(speakers: list[dict], language: str | None = None, progress_callback=None) -> dict[str, list]:
    """Transcribe all speaker files via Amazon Transcribe. Returns {speaker_id: [segments]}.

    Same progress_callback contract as transcription.transcribe_all():
    progress_callback(overall_frac, name, index, total).
    """
    transcripts = {}
    total = len(speakers)
    _check_credentials(os.getenv("AWS_REGION", "us-east-1"))

    for i, speaker in enumerate(speakers):
        if progress_callback:
            progress_callback(i / total, speaker["name"], i, total)

        def _inner(frac: float, *, _i: int = i, _name: str = speaker["name"]) -> None:
            if progress_callback:
                overall = (_i + frac) / total
                progress_callback(overall, _name, _i, total)

        segments = transcribe_file_aws(
            speaker["file_path"], speaker["id"], speaker["name"],
            language=language, progress_callback=_inner,
        )
        transcripts[speaker["id"]] = segments

    return transcripts

# Private AI: Plan

Status: **planned**, not started. Tracked in [ROADMAP.md](../ROADMAP.md).

Darkroom's promise is that **nothing leaves your control**. Media and transcripts stay on your machine by default; when you want more speed or a bigger model, it runs in **your own cloud account** and stays there. The Analyse step (Claude generating the edit decision list) is the one place this isn't fully true today. This plan fixes that: add local AI models so Analyse works with nothing leaving the computer, and make the cloud option provably stay inside the user's AWS account.

---

## Goals

- **Analyse works fully offline** with a local model, with no account, key or network.
- **Cloud AI only runs in the user's own account** (Bedrock today), with settings that keep prompts and outputs from being stored, reviewed or shared.
- **No third-party AI by default.** Anything that would send data outside the user's machine or account is off unless the user turns it on knowingly.
- **The UI says exactly where the transcript is going** before Analyse runs: "on this computer", "your AWS account, region X", or (if enabled) "Anthropic's API, a third party".

## Non-goals (for the first version)

- Fine-tuning or training models on the user's projects.
- Local models for anything beyond Analyse (titles, show notes and chapters can follow once Analyse works).

---

## Where things stand today

Found while writing this plan (`backend/darkroom/services/editor.py`, `api/jobs.py`, `.env.example`):

| | Today | Problem |
|---|---|---|
| Default provider | `AI_PROVIDER=anthropic`: the direct Anthropic API | That's a third party, not the user's account. Contradicts the principle "never send user data to a third party". |
| Bedrock model | `us.anthropic.claude-sonnet-4-5-…` (US cross-Region inference profile) | Stays in AWS and in the US, but can be processed in a different region than `AWS_REGION` (e.g. us-east-1 → us-east-2/us-west-2). |
| Retention | Not checked | Darkroom doesn't verify the account's Bedrock data retention mode, so a model that requires retention and human review would be used silently. |
| UI | "Analyze with AI →", no destination shown | The user isn't told where the transcript goes. |
| Status check | `/api/status` only looks at `ANTHROPIC_API_KEY` | A Bedrock-only setup shows "No API key" and hides the Analyse button (bug). |
| Manual Analysis | Copy the prompt into Claude Code | User-driven, but it also sends the transcript to Anthropic; should say so. |
| Local AI | None | Analyse can't run with nothing leaving the machine. |

---

## Validation: what Bedrock does with your data

Checked against the AWS Bedrock user guide on 8 Oct 2026 ([data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html), [abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html), [data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html), [cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html), [geographic CRIS](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)). Re-check when upgrading models; these terms change.

**Confirmed: the model provider never sees your data.** Models run in AWS-owned "model deployment accounts" that "model providers don't have any access to … they don't have access to Amazon Bedrock logs or to customer prompts and completions." Retained data, where any, "is not shared with third-party model providers", and the legacy `provider_data_share` mode is documented as not sharing anything today.

**Confirmed for most Claude models: zero retention.** Bedrock uses "zero operator access" and "zero data retention … by default, Amazon Bedrock does not store model inputs or outputs." Claude models released before Claude Fable 5 (e.g. Sonnet 4.5/4.6, Opus 4.8) permit mode `none`, so nothing is persisted whatever the account setting.

**Exception: Claude Fable 5 and 5.1.** These require the account's data retention mode to be `aws_review`. All traffic is then **kept for up to 30 days** inside AWS for automated abuse detection, and flagged traffic **may be read by AWS staff**. It is still not shared with Anthropic. With retention set to `none`, these models refuse requests (`ValidationException`), which is the behaviour we want as a safety net. Enterprise ZDR for these models goes through Anthropic, not AWS.

**Cross-Region inference moves data between regions, not out of AWS.** A `us.`/`eu.`/`apac.` profile keeps processing within that geography, on the AWS network, encrypted; CloudTrail in the source region records where each request ran (`additionalEventData.inferenceRegion`). A `global.` profile can route to any commercial region worldwide. Where retention applies, it is stored in the region that processed the request.

**Opt-in logging stays in the user's account.** Model invocation logging is off by default; if the user turns it on, prompts go to their own CloudWatch/S3. Darkroom should never enable it.

**Not used for training.** "AWS does not use inputs or completions generated through the Amazon Bedrock service to train Amazon Bedrock models", and they are "never shared between customers, or with Amazon Bedrock partners" ([AWS AI Service Card](https://docs.aws.amazon.com/ai/responsible-ai/nova-micro-lite-pro/overview.html)).

**Verdict:** with a pre-Fable Claude model, account retention mode `none`, and an in-region or same-geography model ID, the transcript is processed inside the user's AWS account boundary and not stored, reviewed or shared. Darkroom should enforce this rather than assume it.

---

## The plan

### 1. Local AI provider

A new `AI_PROVIDER=local` that never opens a non-loopback connection. Two ways to run the model, worth doing in this order:

- **Local server (first):** talk to an OpenAI-compatible server the user already runs (Ollama, LM Studio, llama.cpp `llama-server`). Small code change, the user picks any model. Darkroom **refuses any base URL that isn't loopback** (`127.0.0.1`, `::1`, `localhost`) so "local" can't silently become remote.
- **Bundled (later, for the installable app):** run a GGUF model in-process with `llama-cpp-python` (Metal on Apple Silicon, CUDA when available, CPU otherwise), downloaded on first use with progress, like the Whisper models.

What the EDL job needs from a local model:
- **Context:** a 1-hour two-person podcast is roughly 10–15k transcript tokens plus a few thousand for the EDL, so a 32k+ context window, or chunking the transcript into overlapping windows and stitching the segments.
- **Valid JSON:** smaller models drift from the format. Use constrained decoding (JSON schema / grammar, supported by llama.cpp and Ollama) instead of relying on the "start with {" prompt and retry.
- **Quality:** pick defaults by benchmark, like transcription. Extend `backend/bench/` with an EDL benchmark: same transcripts through Claude and candidate local models, scored on valid EDL rate, coverage/contiguity errors, speaker-camera accuracy, and clip picks compared with Claude's.

### 2. Lock down Bedrock

- **Check retention before calling.** Read the account's data retention mode for `AWS_REGION` (`GET /data-retention`, needs `bedrock:GetAccountDataRetention`). If it isn't `none`, warn in the UI. Refuse models that require `aws_review` unless the user explicitly allows it, with the 30-day/human-review explanation.
- **Region control.** Default to a geographic profile matching `AWS_REGION` (never `global.`), and offer an in-region model ID for users who want processing to stay in exactly one region. Show the region(s) in the Analyse confirmation.
- **Least-privilege IAM.** Add an optional `infra/` stack (or documented policy) granting only `bedrock:InvokeModel` on the chosen profile/model plus `bedrock:GetAccountDataRetention`, and an example SCP that pins data retention to `none`.
- **Never enable invocation logging** from Darkroom; mention in the docs that if the user has enabled it, prompts land in their own CloudWatch/S3.

### 3. Third-party providers are opt-in and labelled

- Default `AI_PROVIDER` becomes `local` if one is configured, else `bedrock` if set up, else none (Manual Analysis and the "keep everything" EDL still work).
- The direct Anthropic API stays available only as an explicit choice, labelled in the UI as a third party (see Open questions on whether to keep it at all).

### 4. Say where it's going

- Replace "Analyze with AI →" with a confirm step naming the destination: "Runs on this computer (Ollama, qwen…)", "Sent to Bedrock in your AWS account (us-east-1, may process in us-east-2/us-west-2); not stored", or "Sent to Anthropic's API (third party)".
- Manual Analysis gets the same one-line note.
- `/api/status` reports the configured provider, model and destination instead of `anthropic_configured`.

---

## TODO

### Phase 0: Fixes and visibility
- [ ] `/api/status` returns `{provider, model, destination, configured}`; fix Bedrock-only setups hiding Analyse
- [ ] Analyse confirmation shows where the transcript will go; note on Manual Analysis
- [x] README/`.env.example`: "What leaves your machine" section, Anthropic API gap called out, Bedrock data handling summary with links and date checked

### Phase 1: Bedrock lock-down
- [ ] Check account data retention mode before calling; warn when not `none`
- [ ] Refuse `aws_review`-only models (Claude Fable 5/5.1) unless explicitly allowed
- [ ] Geographic profile matching `AWS_REGION` by default; in-region option; never `global.`
- [ ] Least-privilege IAM policy and example retention SCP (`infra/` or docs)

### Phase 2: Local provider (server)
- [ ] `AI_PROVIDER=local` with OpenAI-compatible base URL, loopback-only
- [ ] JSON-schema constrained output for the EDL
- [ ] Transcript chunking for models with small context windows
- [ ] EDL benchmark in `backend/bench/`; choose recommended local models by hardware

### Phase 3: Defaults
- [ ] Default provider order: local → Bedrock → none; direct Anthropic only on explicit opt-in
- [ ] Provider picker in the UI (desktop: settings; browser: read-only from `.env`)

### Phase 4: Bundled local model (with installable builds)
- [ ] `llama-cpp-python` in-process, first-use download with progress, Metal/CUDA/CPU

---

## Decisions

| Decision | Why |
|---|---|
| Only Bedrock counts as "your cloud" for AI today | Prompts are processed in AWS-owned accounts the model provider can't access, and under the user's own AWS agreement, IAM and CloudTrail. |
| Require (or strongly push) Bedrock data retention mode `none` | It's the only mode where AWS guarantees nothing is persisted, and it makes retention-requiring models fail closed. |
| Keep the direct Anthropic API, as an opt-in, with the gap called out in the README | Easiest setup and a path for users without AWS or a capable machine, but it's a third party. The README's "What leaves your machine" section, the provider options and `.env.example` all say so. |
| Local provider must be loopback-only | "Local" has to mean the transcript never leaves the computer, not "whatever URL is in `.env`". |

## Open questions

- Allow Claude Fable 5/5.1 on Bedrock behind an "I accept 30-day retention and possible AWS review" switch, or not at all?
- Which local models to recommend per hardware tier (8 GB laptop, 16–32 GB Apple Silicon, NVIDIA GPU)? Decided by the EDL benchmark.
- Other self-hosted clouds (Azure OpenAI, Vertex AI in the user's own project) later, under the same retention checks?

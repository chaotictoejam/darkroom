# Darkroom

> *Your footage, developed locally.*

A local-first video and podcast editor. Upload your pre-aligned camera or audio files, get an AI-generated edit decision list from Claude, review and tweak cuts in the browser, then render final exports via FFmpeg. Nothing leaves your machine.

> **Darkroom v2 is in planning** — native recording, richer compositing, a choice of local/cloud transcription, 4K exports, and an AI Tools panel with per-project cost estimates. See [docs/v2-roadmap.md](docs/v2-roadmap.md).

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python · FastAPI |
| Transcription | faster-whisper (local, VAD-filtered) or Amazon Transcribe (cloud, optional) |
| AI editing | Anthropic Claude (`claude-sonnet-4-6`) or AWS Bedrock (`claude-sonnet-4-5`) |
| Rendering | FFmpeg |
| Frontend | React · TypeScript · Vite |
| State | JSON files in `projects/` |

---

## Requirements

- Python 3.10+
- Node.js 18+
- FFmpeg (full build — required for rendering)
- An Anthropic API key  
  **or**  
  AWS credentials with access to Bedrock model `us.anthropic.claude-sonnet-4-5-20250929-v1:0`

---

## Install

### 1 — Clone / unzip

```bash
cd darkroom
```

### 2 — FFmpeg

**macOS (Homebrew)**
```bash
brew install ffmpeg
```

**Windows (package manager)**

```powershell
# Chocolatey
choco install ffmpeg-full

# Winget
winget install ffmpeg

# Scoop
scoop install ffmpeg
```

**Windows (manual)**
Download a build from <https://www.gyan.dev/ffmpeg/builds/>, extract it, and add the `bin/` folder to your `PATH`.

**Linux (apt)**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**Linux (Fedora/dnf)**

Fedora ships a limited `ffmpeg-free` package by default, which lacks libass (needed for subtitle burn-in). Enable RPM Fusion and install the full build, allowing it to replace `ffmpeg-free`:

```bash
sudo dnf install -y https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install -y --allowerasing ffmpeg
```

Verify: `ffmpeg -version`

---

### 3 — Dependencies

```bash
make install
```

This creates a Python virtual environment, installs the backend package, and installs frontend npm dependencies.

**Manual steps (if `make` is unavailable):**
```bash
# Python backend
python -m venv .venv
.venv/Scripts/Activate.ps1   # Windows PowerShell
# source .venv/bin/activate  # macOS/Linux
pip install -e "backend/[dev]"

# Frontend
cd frontend && npm install
```

---

### 4 — AI provider

Copy the example env file:
```bash
cp .env.example .env
```

#### Option A — Anthropic API (default)

```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at <https://console.anthropic.com> → API Keys → Create Key.

#### Option B — AWS Bedrock

Requires AWS credentials available in the environment (via `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or an IAM role) and the model `us.anthropic.claude-sonnet-4-5-20250929-v1:0` enabled in your Bedrock console.

```env
AI_PROVIDER=bedrock
AWS_REGION=us-east-1
# BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0  # default, override if needed
```

Also install the `boto3` extra:
```bash
pip install -e "backend/[aws]"
```

---

### 5 — Transcription provider (optional)

By default Darkroom transcribes locally with faster-whisper — free, no AWS needed. You can optionally transcribe via **Amazon Transcribe** instead, per-project, from the upload screen.

```env
TRANSCRIBE_PROVIDER=local        # default
# TRANSCRIBE_PROVIDER=aws
# TRANSCRIBE_S3_BUCKET=darkroom-transcribe-xxxxxxxx  # created by `cdk deploy` in infra/, or bring your own
# AWS_REGION=us-east-1
```

Requires the same `boto3` extra as Bedrock above, plus a scratch S3 bucket (deploy `infra/` — see [Optional: CDK deployment](#optional-cdk-deployment) — or point `TRANSCRIBE_S3_BUCKET` at your own) and AWS credentials with `transcribe:StartTranscriptionJob` / `transcribe:GetTranscriptionJob` and `s3:PutObject`/`GetObject`/`DeleteObject` on that bucket.

#### Improving local accuracy

Cloud transcription is one path to better accuracy, but the local path has real headroom too — Darkroom's faster-whisper pipeline includes:

- **Silero VAD filtering** (always on) — strips silence/breathing before it ever reaches the model, which is a bigger source of hallucinated words than any post-hoc filtering can fully clean up.
- **`large-v3`** as a selectable Whisper model (Setup screen) — the current best-accuracy faster-whisper checkpoint, slower than `medium`/`turbo`.
- **Optional forced alignment** — a wav2vec2 CTC pass (`services/align_engine.py`) that re-times each word against the raw audio, tightening word boundaries beyond what Whisper's own cross-attention timestamps give you. This is what actually matters for word-level cuts and karaoke subtitles, as opposed to plain transcript accuracy. Enable per-project via the "Improve word-timing accuracy" checkbox on the Setup screen (local provider only).

  Requires the `align` extra:
  ```bash
  pip install -e "backend/[align]"
  ```
  This pulls in `torch`/`torchaudio`/`transformers` — a meaningfully heavier install than the base app. It's deliberately **not** the `whisperx` package: that package hard-pins `faster-whisper==1.0.0`/`ctranslate2==4.4.0` (which would downgrade the versions this project uses) and unconditionally imports its diarization module (`pyannote.audio` and its own dependency tree) even when only alignment is needed. `align_engine.py` ports just the forced-alignment algorithm itself (BSD-2-Clause, adapted from [WhisperX](https://github.com/m-bain/whisperX)) without either of those costs.

  Darkroom intentionally has no diarization step anywhere — every track is already speaker-tagged by camera/mic at upload, which is more accurate than guessing speaker identity from a mixed signal.

  Alignment models download per-language on first use (a few hundred MB to ~1GB from Hugging Face/torchaudio, depending on language) and add real processing time — expect it to roughly double per-track transcription time on CPU.

#### Tuning local performance

The local faster-whisper path reads three optional machine-level settings from `.env` (not per-project — these describe your hardware, not your content):

```env
# WHISPER_DEVICE=auto           # "auto" | "cpu" | "cuda"
# WHISPER_COMPUTE_TYPE=int8     # "default" | "int8" | "int8_float32" | "float32" | "float16" (GPU only) | ...
# WHISPER_CPU_THREADS=0         # 0 = autodetect; otherwise your physical core count
```

**GPU (`WHISPER_DEVICE=cuda`) only helps on NVIDIA hardware.** faster-whisper's backend (CTranslate2) supports CUDA exclusively — there's no ROCm/OpenCL path, so AMD and Intel GPUs can't accelerate this step no matter what you set here; `auto` will just keep using the CPU on those systems, same as today. If you do have an NVIDIA GPU, you'll also need CUDA/cuBLAS/cuDNN installed — see [faster-whisper's GPU setup notes](https://github.com/SYSTRAN/faster-whisper#gpu) if `cuda` fails to initialize.

**On CPU, `WHISPER_COMPUTE_TYPE=int8`** is usually the best speed/accuracy tradeoff (int8 quantization, minimal quality loss). `float32` is slower but maximum precision if you ever suspect quantization is hurting a specific recording.

**`WHISPER_CPU_THREADS`** defaults to autodetect (`0`), which is usually fine — set it explicitly only if you notice faster-whisper isn't using your CPU well (e.g. pin it to your physical core count, not hyperthreaded/SMT thread count, to avoid oversubscription if something else on the machine is also CPU-heavy).

These are the same three values passed straight through to `WhisperModel(...)` — [faster-whisper's own docs](https://github.com/SYSTRAN/faster-whisper) cover every valid combination in more depth than is worth duplicating here.

---

## Run

### Development (recommended)

```bash
make dev
```

This starts both servers in parallel:
- **Backend** at `http://localhost:8000` (FastAPI + uvicorn, hot-reload)
- **Frontend** at `http://localhost:5173` (Vite dev server)

Open **http://localhost:5173** in your browser.

### Backend only

```bash
make backend
```

### Frontend only

```bash
make frontend
```

### Production build

```bash
make build
```

Compiles the React app into `frontend/dist`. FastAPI then serves the full app at **http://localhost:8000** — no Vite needed.

---

## Workflow

1. **New Project** — choose **Video** (multi-camera interview/talking head) or **Podcast** (audio-only recording).
2. **Upload files** — add up to 4 pre-aligned camera or audio files, one per speaker. Assign a name to each. Choose the transcript **language** (defaults to English), **transcription engine** (local faster-whisper or Amazon Transcribe), **Whisper model** (defaults to `medium`; `large-v3` for best accuracy), and optionally **forced alignment** for tighter word timing — see [Improving local accuracy](#improving-local-accuracy).
3. **Transcribe** — Whisper runs locally on each file's audio track.
4. **Analyse** — Claude receives the merged transcript and returns an EDL (edit decision list) as JSON with segments and 3–5 suggested Shorts clips.
5. **Review** — video/audio previews, transcript panel, per-segment controls. Toggle cuts, change camera assignments, edit transcript text inline, mute individual words.
6. **Shorts Builder** — pick any AI-suggested clip or define a custom range. Choose subtitle style, accent colour, opacity, and camera layout. Preview the clip before rendering.
7. **Render** — choose export targets (16:9 full edit, 9:16 vertical, or a named Short), an export resolution (1080p or 4K), and FFmpeg renders them with audio normalised to –16 LUFS. If a source camera is below the requested resolution, Darkroom warns you before rendering rather than silently upscaling.
8. **Redo EDL** — re-run the AI analysis on the existing transcript without re-transcribing (sidebar danger zone).

---

## Project types

### Video
Multi-camera interviews, talking heads, or any recording with video. Supports camera switching in the EDL. Renders 16:9 full edit and 9:16 vertical Shorts.

### Podcast
Audio-only recordings. No camera switching. Renders a mixed-audio MP3/AAC output. The setup and editor UIs automatically adapt — file inputs accept audio formats only, the camera layout toggle is hidden.

---

## Shorts rendering

When rendering a Short in **active camera** mode:

- **Camera switching** is driven by the Whisper transcript's speaker assignments, not the EDL. Each speaker switch creates a new cut to the correct camera.
- **Audio** is a normalised mix of all camera microphones, so every speaker is audible regardless of which camera is shown.
- **Subtitles** are burned in and support six styles: `chunk`, `word`, `box`, `box_word`, `karaoke`, `neon`. Box-style subtitles have a configurable opacity.

---

## Project structure

```
darkroom/
├── backend/
│   └── darkroom/
│       ├── main.py          # FastAPI app entry point
│       ├── api/
│       │   ├── projects.py  # project CRUD routes
│       │   ├── jobs.py      # transcription, analysis, render routes + WebSocket
│       │   └── media.py     # file serving helpers
│       ├── services/
│       │   ├── transcription.py     # Whisper transcription (local, VAD-filtered)
│       │   ├── transcription_aws.py # Amazon Transcribe adapter (cloud, optional)
│       │   ├── align_engine.py      # optional wav2vec2 forced alignment (word timing)
│       │   ├── editor.py            # Claude EDL generation (Anthropic API or Bedrock)
│       │   ├── audio_engine.py      # audio-specific FFmpeg filters (loudness, ...)
│       │   └── renderer.py          # FFmpeg rendering / compositing
│       └── storage.py       # project JSON persistence
├── frontend/
│   └── src/
│       ├── views/
│       │   ├── Welcome.tsx  # project list + new project
│       │   ├── Setup.tsx    # file upload + settings
│       │   └── Editor.tsx   # main editor view
│       ├── components/      # TranscriptEditor, VideoPreview, Timeline, etc.
│       └── api/
│           ├── client.ts    # typed API client + WebSocket helper
│           └── types.ts     # shared TypeScript types
├── infra/                   # optional CDK deployment (TypeScript)
│   ├── bin/darkroom.ts      # CDK entry point
│   ├── lib/darkroom-stack.ts # Bedrock Lambda + Transcribe S3 bucket
│   ├── lambda/
│   │   └── handler.py       # async Lambda → Bedrock (Lambda runtime stays Python)
│   ├── package.json
│   ├── tsconfig.json
│   └── cdk.json
├── projects/                # auto-created; stores project JSON + media + outputs
├── Makefile
├── .env                     # AI_PROVIDER + keys
└── .env.example
```

Each project lives in `projects/{8-char-id}/`:
```
projects/
└── a1b2c3d4/
    ├── project.json          # project state (transcript, EDL, word cuts, render history)
    ├── cam_A_alice.mp4       # uploaded camera/audio files
    ├── cam_B_bob.mp4
    └── output/
        ├── fullEdit.mp4
        ├── vertical.mp4
        ├── clip_001.mp4      # named Short exports
        ├── preview.mp4       # proxy preview (regenerated on edit)
        └── subtitles.ass     # generated subtitle file
```

---

## EDL format

```json
{
  "segments": [
    {
      "id": "seg_001",
      "start": 0.0,
      "end": 12.4,
      "keep": true,
      "camera": "A",
      "layout": "single",
      "reason": null
    },
    {
      "id": "seg_002",
      "start": 12.4,
      "end": 15.1,
      "keep": false,
      "camera": "A",
      "layout": "single",
      "reason": "filler words"
    }
  ],
  "clips": [
    {
      "id": "clip_001",
      "label": "Punchy opener",
      "start": 4.2,
      "end": 72.6,
      "reason": "Strong hook, complete thought, no context needed"
    }
  ]
}
```

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | FFmpeg + Anthropic key availability |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project `{name, project_type}` |
| GET | `/api/projects/:id` | Get project state |
| DELETE | `/api/projects/:id` | Delete project |
| POST | `/api/projects/:id/upload` | Upload files, speaker names, language, model |
| POST | `/api/projects/:id/transcribe` | Start Whisper transcription (async) |
| POST | `/api/projects/:id/analyze` | Start Claude EDL generation (async) |
| POST | `/api/projects/:id/skip-analysis` | Generate keep-all EDL without AI |
| POST | `/api/projects/:id/reset-edl` | Clear EDL, return to transcribed state |
| POST | `/api/projects/:id/reset` | Full reset to uploaded state |
| PUT | `/api/projects/:id/edl` | Save edited EDL |
| PATCH | `/api/projects/:id/transcript/:index` | Edit a transcript segment's text |
| PUT | `/api/projects/:id/word-cuts` | Save word-level cut list |
| PUT | `/api/projects/:id/word-mutes` | Save word-level mute list |
| GET | `/api/projects/:id/resolution-check` | Warn if source cameras are below a requested export resolution `?resolution=1080p\|4k` |
| POST | `/api/projects/:id/render` | Start FFmpeg render `{targets:[…], resolution?}` |
| POST | `/api/projects/:id/render-short` | Render a named Short with subtitle options `{…, resolution?}` |
| POST | `/api/projects/:id/preview` | Generate proxy preview video (async) |
| GET | `/api/ws/:id` | WebSocket — stream job progress events |
| GET | `/projects/:id/files/:path` | Serve project file (video / output) |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `anthropic` | `anthropic` to use the Anthropic API; `bedrock` to use AWS Bedrock |
| `ANTHROPIC_API_KEY` | — | **Required when `AI_PROVIDER=anthropic`.** Your Anthropic API key. |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock/Transcribe calls |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock model ID override |
| `TRANSCRIBE_PROVIDER` | `local` | `local` for faster-whisper; `aws` to default new projects to Amazon Transcribe |
| `TRANSCRIBE_S3_BUCKET` | — | **Required when using Amazon Transcribe.** Scratch bucket for uploaded audio + job output; created by `cdk deploy` in `infra/` |
| `WHISPER_DEVICE` | `auto` | `auto` \| `cpu` \| `cuda` — see [Tuning local performance](#tuning-local-performance). GPU is NVIDIA-only. |
| `WHISPER_COMPUTE_TYPE` | `default` | CTranslate2 quantization mode, e.g. `int8` (fast CPU default recommendation) or `float32` |
| `WHISPER_CPU_THREADS` | `0` (autodetect) | Threads faster-whisper uses on CPU |

Whisper model, language, and transcription provider are set per-project in the upload UI (defaulting from `.env`); `WHISPER_DEVICE`/`WHISPER_COMPUTE_TYPE`/`WHISPER_CPU_THREADS` are machine-level hardware settings, not per-project.

---

## Optional: CDK deployment

The `infra/` directory contains an [AWS CDK](https://aws.amazon.com/cdk/) **TypeScript** stack (`cdk-lib` + `constructs` — no Docker required to synth or deploy) that provisions:

- an async Lambda function wired to Bedrock, for serverless/multi-user deployments where you want EDL generation to run in the cloud rather than locally
- an S3 scratch bucket for **Amazon Transcribe** (see [Transcription provider](#5--transcription-provider-optional))

```
infra/
├── bin/darkroom.ts        # CDK entry point
├── lib/darkroom-stack.ts  # Stack: Lambda + IAM + Function URL + Transcribe bucket
├── lambda/
│   └── handler.py         # Async Lambda handler → Bedrock (Lambda runtime stays Python)
├── package.json           # aws-cdk-lib, constructs, aws-cdk, ts-node, typescript
├── tsconfig.json
└── cdk.json
```

### Deploy

```bash
cd infra
npm install

npx cdk bootstrap   # first time only, per account/region
npx cdk deploy
```

The stack outputs:
- **`EdlFunctionArn`** — invoke via `boto3.client("lambda").invoke(...)`
- **`EdlFunctionUrl`** — HTTPS endpoint (IAM-authenticated)
- **`TranscribeBucketName`** — copy into `.env` as `TRANSCRIBE_S3_BUCKET` to enable `TRANSCRIBE_PROVIDER=aws`

The Lambda accepts `{ "prompt": "<formatted prompt>", "retry": false }` and returns `{ "edl_raw": "<json string>" }`.

---

## Costs

Local Whisper transcription and FFmpeg rendering run locally and are always free. The only billable steps are **Analyse** (the Claude call that generates the EDL) and, if you opt into it per-project, **cloud transcription via Amazon Transcribe** instead of local Whisper.

### Amazon Transcribe pricing (optional, only if `TRANSCRIBE_PROVIDER=aws`)

Amazon Transcribe bills per second of audio processed, roughly **$0.024/minute** (standard tier, first 250k minutes/month — verify current rates on the [Transcribe pricing page](https://aws.amazon.com/transcribe/pricing/) before budgeting). A 30-minute, 2-speaker episode transcribes two ~30-minute audio tracks ≈ $1.44 total. Local faster-whisper remains $0.

### Model pricing

| Provider | Model | Input | Output |
|----------|-------|-------|--------|
| Anthropic API | `claude-sonnet-4-6` | $3.00 / M tokens | $15.00 / M tokens |
| AWS Bedrock | `claude-sonnet-4-5` (cross-region) | $3.00 / M tokens | $15.00 / M tokens |

> Prices are per million tokens and subject to change. Verify current rates at the Anthropic and AWS Bedrock pricing pages before budgeting.

### Typical per-edit cost

Token consumption scales with episode length. The transcript is the dominant input cost; the EDL JSON segments are the dominant output cost.

| Episode length | Input tokens | Output tokens | Estimated cost |
|----------------|-------------|---------------|---------------|
| 15 min (1 speaker) | ~4,000 | ~1,500 | ~$0.03 |
| 30 min (2 speakers) | ~7,500 | ~3,500 | ~$0.07 |
| 60 min (2–4 speakers) | ~14,000 | ~6,500 | ~$0.13 |

These are rough estimates. A dense multi-speaker episode produces more EDL segments (more output tokens); a solo monologue produces fewer.

Shorts clips and re-renders do **not** generate additional AI calls — they reuse the existing EDL.

### CDK stack costs (infra/)

| Component | Cost |
|-----------|------|
| Lambda at idle | **$0.00** |
| Lambda per invocation (512 MB × up to 5 min) | < $0.001 |
| Bedrock model call | Same per-token rates as above |
| Transcribe scratch S3 bucket (audio deleted after each job; 1-day lifecycle backstop) | Negligible — pennies/month even under regular use |
| CDK bootstrap S3 storage (deployment artifact) | < $0.001 / month |

The Lambda and Transcribe bucket add effectively zero overhead on top of the Bedrock/Transcribe usage cost itself.

---

## Troubleshooting

**"FFmpeg not found"** — make sure `ffmpeg` is on your `PATH`. Run `ffmpeg -version` to test.

**Whisper produces wrong language / hallucinations** — set the language explicitly in the upload form rather than using Auto-detect. English recordings should use `English`.

**Whisper is slow** — choose a smaller model (`small` or `base`) in the upload form, or run on a machine with a GPU.

**Short has no audio / silent** — ensure all camera files have an audio track. Darkroom mixes all microphones; a missing audio stream will cause FFmpeg to fail.

**SAR mismatch error in FFmpeg** — handled automatically (`setsar=1` is applied to every stream). If still occurring, check that all camera files are standard H.264 MP4.

**Claude returns invalid JSON** — the app retries once with a stricter prompt. If it fails again, the error is surfaced in the UI.

**MP3 / audio file not selectable in upload dialog** — on Windows, `audio/*` MIME filtering is unreliable. The file input includes explicit extensions (`.mp3`, `.m4a`, `.wav`, etc.) which should allow selection. If a format is missing, rename it to `.mp3` or `.m4a`.

**Seeing the old vanilla JS UI** — make sure you're opening `http://localhost:5173` (the Vite dev server), not port 8000. Port 8000 only serves the React app if you've run `make build` first.

**macOS port 5000 conflict** — not applicable; Darkroom uses ports 8000 and 5173.

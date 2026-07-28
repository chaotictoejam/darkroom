# Darkroom

> *Your footage, developed locally.*

A local-first video and podcast editor. Upload your pre-aligned camera or audio files, get an AI-generated edit decision list from Claude, review and tweak cuts in the browser, then render final exports via FFmpeg. Nothing leaves your machine.

> **Darkroom v2 is in planning** — native recording, richer compositing, a choice of local/cloud transcription, 4K exports, and an AI Tools panel with per-project cost estimates. See [docs/v2-roadmap.md](docs/v2-roadmap.md).

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python · FastAPI |
| Transcription | faster-whisper (local) |
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
pip install -e "backend/[bedrock]"
```

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
2. **Upload files** — add up to 4 pre-aligned camera or audio files, one per speaker. Assign a name to each. Choose the transcript **language** (defaults to English) and **Whisper model** (defaults to `medium`).
3. **Transcribe** — Whisper runs locally on each file's audio track.
4. **Analyse** — Claude receives the merged transcript and returns an EDL (edit decision list) as JSON with segments and 3–5 suggested Shorts clips.
5. **Review** — video/audio previews, transcript panel, per-segment controls. Toggle cuts, change camera assignments, edit transcript text inline, mute individual words.
6. **Shorts Builder** — pick any AI-suggested clip or define a custom range. Choose subtitle style, accent colour, opacity, and camera layout. Preview the clip before rendering.
7. **Render** — choose export targets (16:9 full edit, 9:16 vertical, or a named Short) and FFmpeg renders them with audio normalised to –16 LUFS.
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
│       │   ├── transcriber.py  # Whisper transcription
│       │   ├── editor.py       # Claude EDL generation (Anthropic API or Bedrock)
│       │   └── renderer.py     # FFmpeg rendering
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
├── infra/                   # optional CDK deployment (Bedrock Lambda)
│   ├── app.py               # CDK entry point
│   ├── darkroom_stack.py    # Lambda + IAM + Function URL
│   ├── lambda/
│   │   └── handler.py       # async Lambda → Bedrock
│   ├── requirements.txt
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
| POST | `/api/projects/:id/render` | Start FFmpeg render `{targets:[…]}` |
| POST | `/api/projects/:id/render-short` | Render a named Short with subtitle options |
| POST | `/api/projects/:id/preview` | Generate proxy preview video (async) |
| GET | `/api/ws/:id` | WebSocket — stream job progress events |
| GET | `/projects/:id/files/:path` | Serve project file (video / output) |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `anthropic` | `anthropic` to use the Anthropic API; `bedrock` to use AWS Bedrock |
| `ANTHROPIC_API_KEY` | — | **Required when `AI_PROVIDER=anthropic`.** Your Anthropic API key. |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock calls (used when `AI_PROVIDER=bedrock`) |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock model ID override |

Whisper model and language are set per-project in the upload UI, not in `.env`.

---

## Optional: CDK deployment (Bedrock Lambda)

The `infra/` directory contains an [AWS CDK](https://aws.amazon.com/cdk/) Python stack that deploys an async Lambda function wired to Bedrock. This is useful for serverless or multi-user deployments where you want the EDL generation to run in the cloud rather than locally.

```
infra/
├── app.py              # CDK entry point
├── darkroom_stack.py   # Stack: Lambda + IAM + Function URL
├── lambda/
│   └── handler.py      # Async Lambda handler → Bedrock
├── requirements.txt    # aws-cdk-lib, constructs
└── cdk.json
```

### Deploy

```bash
cd infra
python -m venv .venv && .venv/Scripts/Activate.ps1   # Windows
# source .venv/bin/activate                           # macOS/Linux
pip install -r requirements.txt

cdk bootstrap   # first time only, per account/region
cdk deploy
```

The stack outputs:
- **`EdlFunctionArn`** — invoke via `boto3.client("lambda").invoke(...)`
- **`EdlFunctionUrl`** — HTTPS endpoint (IAM-authenticated)

The Lambda accepts `{ "prompt": "<formatted prompt>", "retry": false }` and returns `{ "edl_raw": "<json string>" }`.

---

## Costs

Whisper transcription and FFmpeg rendering run locally and are always free. The only billable step is **Analyse** — the single Claude call that generates the EDL.

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

### CDK Lambda costs (infra/)

| Component | Cost |
|-----------|------|
| Lambda at idle | **$0.00** |
| Lambda per invocation (512 MB × up to 5 min) | < $0.001 |
| Bedrock model call | Same per-token rates as above |
| CDK bootstrap S3 storage (deployment artifact) | < $0.001 / month |

The Lambda adds effectively zero overhead on top of the Bedrock model cost.

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

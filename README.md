# Darkroom

> *Your footage, developed locally.*

A local-first, multi-camera podcast editor. Upload your pre-aligned camera files, get an AI-generated edit decision list from Claude, review and tweak cuts in the browser, then render final exports via FFmpeg. Nothing leaves your machine.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python · Flask |
| Transcription | OpenAI Whisper (local) |
| AI editing | Anthropic Claude (`claude-sonnet-4-6`) |
| Rendering | FFmpeg |
| Frontend | Vanilla HTML/JS/CSS (single `index.html`) |
| State | JSON files in `projects/` |

---

## Requirements

- Python 3.10+
- FFmpeg
- An Anthropic API key

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

**Windows**
Download a build from <https://www.gyan.dev/ffmpeg/builds/> (e.g. `ffmpeg-release-essentials.zip`), extract it, and add the `bin/` folder to your `PATH`.

```powershell
# PowerShell — add to PATH for this session
$env:PATH += ";C:\ffmpeg\bin"
```

Or add it permanently via *System Properties → Environment Variables*.

**Linux (apt)**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**Linux (dnf/yum)**
```bash
sudo dnf install ffmpeg
```

Verify: `ffmpeg -version`

---

### 3 — Python dependencies

Create a virtual environment (recommended):

```bash
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows (PowerShell)
.venv\Scripts\Activate.ps1
```

Install packages:

```bash
pip install -r requirements.txt
```

> **Note — PyTorch for Whisper:** `openai-whisper` depends on PyTorch. The `pip install` above installs the CPU-only version automatically. For GPU acceleration install the matching CUDA build from <https://pytorch.org/get-started/locally/> first.

---

### 4 — API key

**Get a key:**

1. Go to **https://console.anthropic.com** and sign up or log in.
2. In the left sidebar click **API Keys → Create Key**.
3. Copy the key — it starts with `sk-ant-…` and is only shown once.

> **Billing:** New accounts receive a small free credit. After it's used up, add a payment method under *Billing*. Cost is pay-as-you-go; a typical podcast edit (one Claude call, ~10,000-word transcript) costs well under $0.10.

Edit `.env` and paste your key:

```
ANTHROPIC_API_KEY=sk-ant-...
WHISPER_MODEL=base
```

Available Whisper model sizes (larger = more accurate, slower):
`tiny` · `base` · `small` · `medium` · `large`

---

## Run

```bash
python app.py
```

Open **http://localhost:5000** in your browser.

---

## Workflow

1. **New Project** — give it a name.
2. **Upload cameras** — add 2–4 pre-aligned video files, one per speaker. Assign a name to each.
3. **Transcribe** — Whisper runs locally on each file's audio track (speaker is already known per file).
4. **Analyse** — Claude receives the merged transcript and returns an EDL (edit decision list) as JSON.
5. **Review** — camera previews, per-speaker timeline tracks, transcript panel. Toggle cuts, change camera assignments, change layouts.
6. **Export EDL** — download the raw JSON edit decision list.
7. **Render** — choose export targets (16:9 full edit, 9:16 vertical, best 60–90s Short) and FFmpeg renders them.

---

## Project structure

```
darkroom/
├── app.py               # Flask server + API routes
├── processor.py         # Whisper transcription + transcript merge
├── editor.py            # Claude API call + EDL generation
├── renderer.py          # FFmpeg rendering logic
├── static/
│   └── index.html       # Full UI (single file)
├── projects/            # Auto-created; stores project JSON + video files + outputs
├── .env                 # ANTHROPIC_API_KEY, WHISPER_MODEL
└── requirements.txt
```

Each project lives in `projects/{8-char-id}/`:
```
projects/
└── a1b2c3d4/
    ├── project.json          # project state
    ├── cam_A_alice.mp4       # uploaded camera files
    ├── cam_B_bob.mp4
    └── output/
        ├── fullEdit.mp4
        ├── vertical.mp4
        └── short.mp4
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
      "label": "Best 60-90s clip for Shorts",
      "start": 4.2,
      "end": 94.2,
      "reason": "Strong hook, complete thought"
    }
  ]
}
```

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | FFmpeg availability, Whisper model |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project `{name}` |
| GET | `/api/projects/:id` | Get project state |
| DELETE | `/api/projects/:id` | Delete project |
| POST | `/api/projects/:id/upload` | Upload camera files + speaker names |
| POST | `/api/projects/:id/transcribe` | Start Whisper transcription (async) |
| POST | `/api/projects/:id/analyze` | Start Claude EDL generation (async) |
| PUT | `/api/projects/:id/edl` | Save edited EDL |
| POST | `/api/projects/:id/render` | Start FFmpeg render `{targets:[…]}` |
| GET | `/projects/:id/files/:path` | Serve project file (video / output) |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required. Your Anthropic API key. |
| `WHISPER_MODEL` | `base` | Whisper model size. |

---

## Troubleshooting

**"FFmpeg not found"** — make sure `ffmpeg` is on your `PATH`. Run `ffmpeg -version` to test.

**Whisper is slow** — use `WHISPER_MODEL=tiny` for faster (less accurate) transcription, or run on a machine with a GPU.

**Claude returns invalid JSON** — the app retries once with a stricter prompt. If it fails again, the error message from Claude is surfaced in the UI.

**Port 5000 in use** — change the port in `app.py`: `app.run(port=5001)`.

**macOS port 5000 conflict** — macOS Monterey+ runs AirPlay Receiver on 5000. Disable it in *System Settings → AirDrop & Handoff* or change the port.

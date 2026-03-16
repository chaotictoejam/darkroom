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
- FFmpeg (full build — required for subtitle burn-in)
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

**Windows (package manager)**

The **full** build is required — it includes libass for subtitle burn-in. The essentials build does not.

```powershell
# Chocolatey
choco install ffmpeg-full

# Winget
winget install ffmpeg

# Scoop
scoop install ffmpeg
```

**Windows (manual)**
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

> **Note — Windows slow first start:** On first run, Windows Defender scans PyTorch DLLs which can take 30–60 seconds. Subsequent starts are fast. To fix permanently, add your Python directory to Defender exclusions.

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
```

The `.env` only needs the API key. Whisper model and language are selected per-project in the UI.

---

## Run

```bash
python app.py
```

Open **http://localhost:5000** in your browser.

---

## Workflow

1. **New Project** — give it a name.
2. **Upload cameras** — add 2–4 pre-aligned video files, one per speaker. Assign a name to each. Choose the transcript **language** (defaults to English) and **Whisper model** (defaults to `medium`).
3. **Transcribe** — Whisper runs locally on each file's audio track.
4. **Analyse** — Claude receives the merged transcript and returns an EDL (edit decision list) as JSON with segments and 3–5 suggested Shorts clips.
5. **Review** — camera previews, transcript panel, per-segment controls. Toggle cuts, change camera assignments, edit transcript text inline.
6. **Shorts Builder** — pick any AI-suggested clip or define a custom range. Choose subtitle style, accent colour, opacity, subtitle position, and camera layout (active speaker or all cameras). Preview the clip with live subtitles before rendering.
7. **Render** — choose export targets (16:9 full edit, 9:16 vertical, or a named Short) and FFmpeg renders them with audio normalised to –16 LUFS.
8. **Redo EDL** — re-run the AI analysis on the existing transcript without re-transcribing (sidebar danger zone).

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
├── app.py               # Flask server + API routes
├── processor.py         # Whisper transcription + transcript merge
├── editor.py            # Claude API call + EDL generation
├── renderer.py          # FFmpeg rendering logic
├── static/
│   └── index.html       # Full UI (single file)
├── projects/            # Auto-created; stores project JSON + video files + outputs
├── .env                 # ANTHROPIC_API_KEY
└── requirements.txt
```

Each project lives in `projects/{8-char-id}/`:
```
projects/
└── a1b2c3d4/
    ├── project.json          # project state (includes transcript, EDL, render history)
    ├── cam_A_alice.mp4       # uploaded camera files
    ├── cam_B_bob.mp4
    └── output/
        ├── fullEdit.mp4
        ├── vertical.mp4
        ├── clip_001.mp4      # named Short exports
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

Claude is prompted to produce 3–5 clips, each between 15 and 90 seconds. Segments are granular (one per speaker turn) so camera switching works correctly.

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | FFmpeg availability |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project `{name}` |
| GET | `/api/projects/:id` | Get project state |
| DELETE | `/api/projects/:id` | Delete project |
| POST | `/api/projects/:id/upload` | Upload camera files, speaker names, language, model |
| POST | `/api/projects/:id/transcribe` | Start Whisper transcription (async) |
| POST | `/api/projects/:id/analyze` | Start Claude EDL generation (async) |
| POST | `/api/projects/:id/skip-analysis` | Generate keep-all EDL without AI |
| POST | `/api/projects/:id/reset-edl` | Clear EDL, return to transcribed state |
| POST | `/api/projects/:id/reset` | Full reset to uploaded state |
| PUT | `/api/projects/:id/edl` | Save edited EDL |
| PATCH | `/api/projects/:id/transcript/:index` | Edit a transcript segment's text |
| POST | `/api/projects/:id/render` | Start FFmpeg render `{targets:[…]}` |
| POST | `/api/projects/:id/render-short` | Render a named Short with subtitle options |
| GET | `/projects/:id/files/:path` | Serve project file (video / output) |

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | **Required.** Your Anthropic API key. |

Whisper model and language are set per-project in the upload UI, not in `.env`.

---

## Troubleshooting

**"FFmpeg not found"** — make sure `ffmpeg` is on your `PATH`. Run `ffmpeg -version` to test.

**Whisper produces wrong language / hallucinations** — set the language explicitly in the upload form rather than using Auto-detect. English podcasts should use `English`.

**Whisper is slow** — choose a smaller model (`small` or `base`) in the upload form, or run on a machine with a GPU.

**Short has no audio / silent** — ensure all camera files have an audio track. Darkroom mixes all microphones; a missing audio stream will cause FFmpeg to fail.

**SAR mismatch error in FFmpeg** — this is handled automatically (`setsar=1` is applied to every stream). If you still see it, check that all camera files are standard H.264 MP4.

**Claude returns invalid JSON** — the app retries once with a stricter prompt. If it fails again, the error message from Claude is surfaced in the UI.

**Port 5000 in use** — change the port in `app.py`: `app.run(port=5001)`.

**macOS port 5000 conflict** — macOS Monterey+ runs AirPlay Receiver on 5000. Disable it in *System Settings → AirDrop & Handoff* or change the port.

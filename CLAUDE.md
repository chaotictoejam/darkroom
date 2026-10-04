# Darkroom

Local-first video and podcast editor: record or upload tracks → transcribe locally (faster-whisper) → Claude generates an edit decision list (EDL) → review in the browser/desktop app → render with FFmpeg.

## Principles (from ROADMAP.md, apply to every change)

- **Local by default.** Everything must work with no cloud set up.
- **Cloud is opt-in and self-hosted** in the user's own account (AWS or similar). Never add a shared Darkroom service or send user data to a third party. The only thing that leaves the machine today is transcript text in the Analyse step.
- Cloud resources are **session/job-scoped** and cleaned up automatically.
- Say plainly in the UI when something will be sent off the machine.

## Commands

```bash
make install           # pip install -e "backend/[dev]" into .venv + npm install in frontend/
make dev               # backend :8000 (reload) + Vite :5173 — open http://localhost:5173
make build             # frontend → frontend/dist (FastAPI serves it at :8000)
make lint              # TypeScript check (tsc --noEmit)
make desktop-install   # Electron into desktop/node_modules
make desktop           # build, then Electron starts its own backend on a free port
make desktop-dev       # backend + Vite + Electron with hot reload

cd backend && ../.venv/bin/python -m pytest -q tests   # backend tests (need ffmpeg on PATH)
```

Requires Python 3.11+ (pyproject), Node 18+, full FFmpeg. AI provider config lives in `.env` (see `.env.example`).

## Layout

- `backend/darkroom/` — FastAPI app
  - `main.py` app + SPA serving; `run()` honours `DARKROOM_PORT`; `__main__.py` lets the desktop app run `python -m darkroom`
  - `storage.py` project JSON persistence
  - `api/projects.py` CRUD · `api/media.py` upload, word cuts/mutes, transcript edits, waveform · `api/jobs.py` transcribe/analyse/render/preview jobs + WebSocket progress
  - `services/transcription.py` faster-whisper + transcript merge · `services/editor.py` Claude EDL generation (Anthropic API or Bedrock) · `services/renderer.py` FFmpeg rendering, face-centred crops
- `frontend/src/` — React + TypeScript + Vite
  - `App.tsx` routes between views by `project.status` (no router library)
  - `views/` Welcome, Setup, Processing, Editor · `components/` TranscriptEditor, VideoPreview, Recorder
  - `api/client.ts` typed API client + `subscribeToProgress` WebSocket · `api/types.ts` shared types
  - `desktop.ts` typed `window.darkroom` bridge (undefined in a plain browser)
- `desktop/` — Electron shell: `main.cjs` (spawns backend, permissions, CSP, single instance), `preload.cjs` (bridge)
- `infra/` — optional AWS CDK (Python) stacks
- `docs/` — design plans for roadmap items; `ROADMAP.md` — Done / Next / Ideas
- `projects/` — user data, gitignored; never commit or delete it

## How things work

**Projects** are `projects/<8-hex-id>/project.json` plus media and `output/`. `save_project` writes atomically. When adding a field to the project, add it to `new_project()` **and** to `_DEFAULTS` in `storage.py` so old projects backfill.

**Status lifecycle:** `created → uploaded → transcribing → transcribed → analyzing → ready`, plus `rendering` and `error`. Keep `ProjectStatus` in `api/types.ts` and `App.tsx` routing in sync with the backend.

**Speakers/tracks:** up to 4, ids `A`–`D`, files named `cam_<id>_<name>`. Each speaker's track is transcribed separately and merged by time. Audio-only projects have `project_type: "podcast"`.

**Long-running jobs** run in a `threading.Thread` and report through `_update_progress(project_id, status=..., progress={step, percent, message})` in `api/jobs.py`, which saves the project and pushes to WebSocket subscribers. Follow that pattern for new jobs; don't block the event loop (use `asyncio.to_thread` for slow work in async routes). uvicorn must run with **one worker**: the Whisper model and job state live in process memory.

**FFmpeg/ffprobe** are called via `subprocess` with arg lists (never `shell=True`).

**Recordings:** `MediaRecorder` output is streamed WebM/Ogg with no duration, so `api/media.py::_normalize_recording` transcodes it on upload. Planned studio formats: MP4 for video, WAV for audio, MP3 as an export (see `docs/recording-studio.md`).

## Conventions

- **Frontend:** inline `style={{}}` objects using the CSS variables in `index.css` (`--bg`, `--bg-card`, `--bg-elevated`, `--border`, `--text`, `--text-muted`, `--accent`, `--radius`). No CSS framework. TS is strict with `noUnusedLocals`/`noUnusedParameters`.
- **Same-origin, relative URLs only** (`/api/...`, `/projects/...`). Never hardcode `localhost:8000`: Vite proxies in dev, and the desktop app uses a random port.
- Desktop-only features go through `window.darkroom` and must degrade gracefully in a browser (`if (desktop) ...`).
- **Electron security:** `contextIsolation` + `sandbox` on, no Node in the renderer. The permission handler in `main.cjs` is an allow-list (currently microphone + clipboard write); camera/screen capture must be added there explicitly. Production pages get a strict CSP: no external scripts or inline `<script>`.
- Python: type hints, small private helpers prefixed `_`, module docstrings at the top of files.
- Commits: one logical change each, imperative subject line; work on a feature branch, not `main`.

## Planning docs

Roadmap items have a plan in `docs/` with Goals, design, a phased **TODO** checklist, Decisions and Open questions. When implementing:
- Read the relevant plan first and follow its Decisions.
- Tick TODO boxes as work lands; move finished roadmap items to **Done** in `ROADMAP.md`.
- Record new decisions in the doc's Decisions table rather than only in code or commit messages.

## Testing

- Backend: pytest in `backend/tests/` (uses `tmp_path`; skips if ffmpeg is missing). Point `DARKROOM_PROJECTS_DIR` at a temp dir for anything that touches storage.
- Frontend: no unit tests yet; `make lint` and `npm run build` must pass.
- End to end: Playwright's `_electron` API can drive the desktop app. Launch Electron with `--use-fake-device-for-media-stream` to test recording without real mics, and stub `/transcribe` to avoid downloading a Whisper model.
- First real transcription downloads the selected Whisper model (hundreds of MB to GBs).

## Known gotchas

- README drift: it says `services/transcriber.py` (actual: `transcription.py`), Python 3.10+ (actual: 3.11+), and that podcasts render to MP3/AAC (the renderer has no MP3 output yet).
- `.gitignore` ignores every `build/` directory; don't put tracked files in one (use e.g. `desktop/resources/`).
- `make desktop` needs a built frontend; `make desktop-dev` needs ports 8000 and 5173 free.
- Upload currently reads whole files into memory (`await f.read()`); fine for audio, heavy for large video (planned fix in `docs/fast-transcription.md`).

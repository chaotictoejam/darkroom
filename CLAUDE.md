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
cd backend && ../.venv/bin/python bench/transcription.py --help   # transcription benchmark (pip install -e ".[bench]")
```

Requires Python 3.11+ (pyproject), Node 18+, full FFmpeg. AI provider config lives in `.env` (see `.env.example`).

## Layout

- `backend/darkroom/` — FastAPI app
  - `main.py` app + SPA serving; `run()` honours `DARKROOM_PORT`; `__main__.py` lets the desktop app run `python -m darkroom`
  - `storage.py` project JSON persistence + `editing_project()` lock
  - `api/projects.py` CRUD + PATCH · `api/media.py` upload, word cuts/mutes, transcript edits, waveform · `api/jobs.py` transcribe/analyse/render/preview jobs + WebSocket progress · `api/takes.py` recording studio takes, per-take transcription worker, crash recovery
  - `services/transcription.py` faster-whisper (cached model, VAD + batched pipeline, int8 CPU / float16 CUDA, default model by device and language: `small` for English on CPU, else `turbo`) + transcript merge · `services/editor.py` Claude EDL generation (Anthropic API or Bedrock) · `services/renderer.py` FFmpeg rendering (video, and MP3/WAV for audio-only), face-centred crops · `services/takes.py` chunk append, finalise to WAV, join takes, transcript offsets
- `frontend/src/` — React + TypeScript + Vite
  - `App.tsx` routes between views by `project.source` and `project.status` (no router library)
  - `views/` Welcome (New Project: Upload or Record), Setup (upload), Studio (recording), Processing, Editor · `components/` TranscriptEditor, VideoPreview, `Studio/` (mic engine, AudioWorklet, chunk uploader, waveform lanes, meters, takes strip)
  - `transcriptionOptions.ts` Whisper model and language lists shared by Setup and Studio
  - `api/client.ts` typed API client + `subscribeToProgress` WebSocket · `api/types.ts` shared types
  - `desktop.ts` typed `window.darkroom` bridge (undefined in a plain browser)
- `desktop/` — Electron shell: `main.cjs` (spawns backend, permissions, CSP, single instance), `preload.cjs` (bridge)
- `infra/` — optional AWS CDK (Python) stacks; `infra/bench/run-gpu-benchmark.sh` runs the transcription benchmark on a temporary EC2 GPU instance
- `backend/bench/` — transcription benchmark (`README.md`: datasets, running locally/on AWS, sharing results); committed results without transcripts in `bench/results/`
- `docs/` — design plans for roadmap items; `ROADMAP.md` — Done / Next / Ideas
- `projects/` — user data, gitignored; never commit or delete it

## How things work

**Projects** are `projects/<8-hex-id>/project.json` plus media and `output/`. `save_project` writes atomically. When adding a field to the project, add it to `new_project()` **and** to `_DEFAULTS` in `storage.py` so old projects backfill.

**Projects have a `source`:** `"upload"` or `"record"` (backfilled to `"upload"`).

**Status lifecycle:** upload: `created → uploaded → transcribing → transcribed → analyzing → ready`; record: `recording` (in the studio) `→ transcribed` on Finish & edit, then the same. Plus `rendering` and `error`. Keep `ProjectStatus` in `api/types.ts` and `App.tsx` routing in sync with the backend.

**Speakers/tracks:** up to 4, ids `A`–`D`. Uploaded files are named `cam_<id>_<name>`; recorded projects get joined tracks `cam_<id>.wav`. Each speaker's track is transcribed separately and merged by time. Audio-only projects have `project_type: "podcast"`; for uploads it's detected from the files (any real video stream → `video`).

**Concurrent writes:** background jobs run alongside each other (e.g. a take transcribing while the next records), so change a project with `with editing_project(project_id) as proj:` (per-project lock, load, save) rather than a bare `get_project` → `save_project`.

**Long-running jobs** run in a `threading.Thread` and report through `_update_progress(project_id, status=..., progress={step, percent, message})` in `api/jobs.py`, which saves the project and pushes to WebSocket subscribers. Follow that pattern for new jobs; don't block the event loop (use `asyncio.to_thread` for slow work in async routes). uvicorn must run with **one worker**: the Whisper model and job state live in process memory.

**FFmpeg/ffprobe** are called via `subprocess` with arg lists (never `shell=True`).

**Recording studio** (`docs/recording-studio.md`, Phase 1 done: audio only):
- Takes live in `projects/<id>/takes/take_NNN/`. While recording, each mic's 1-second `MediaRecorder` chunks are POSTed to `/api/projects/:id/takes/:take/mic_<id>/chunk?offset=N` and appended to `mic_<id>.part`; the byte offset makes resends safe and gaps an error.
- **Stop** finalises each `.part` to mono 48 kHz 16-bit WAV (`mic_<id>.wav`), then queues the take for transcription. One worker transcribes one take at a time; results go to `take_NNN/transcript.json` with take-relative times, and progress is pushed as WebSocket events `{type: "take", take}`.
- **Finish & edit** joins takes in strip order into `cam_<id>.wav` (silence for a mic missing from a take), shifts take transcripts into `merged_transcript`, and saves `take_boundaries`.
- On startup, `recover_unfinished_takes()` finalises takes left `recording` by a crash (flagged `recovered`) and requeues unfinished transcriptions.
- Live waveforms come from an `AudioWorklet` (`components/Studio/peak-worklet.js`, one peak per 10 ms). It must load as a bundled file: the production CSP blocks blob/data script URLs, which is why `vite.config.ts` never inlines `.js` assets.
- Uploads still pass through `api/media.py::_normalize_recording`, which transcodes duration-less streamed WebM/Ogg (e.g. browser recordings) to FLAC.

## Conventions

- **Frontend:** inline `style={{}}` objects using the CSS variables in `index.css` (`--bg`, `--bg-card`, `--bg-elevated`, `--border`, `--text`, `--text-muted`, `--accent`, `--radius`). No CSS framework. TS is strict with `noUnusedLocals`/`noUnusedParameters`.
- **Same-origin, relative URLs only** (`/api/...`, `/projects/...`). Never hardcode `localhost:8000`: Vite proxies in dev, and the desktop app uses a random port.
- Desktop-only features go through `window.darkroom` and must degrade gracefully in a browser (`if (desktop) ...`).
- **Electron security:** `contextIsolation` + `sandbox` on, no Node in the renderer. The permission handler in `main.cjs` is an allow-list (currently microphone + clipboard write); camera/screen capture must be added there explicitly. Production pages get a strict CSP: no external scripts, inline `<script>`, or blob/data script URLs (AudioWorklets included).
- Python: type hints, small private helpers prefixed `_`, module docstrings at the top of files.
- Commits: one logical change each, imperative subject line; work on a feature branch, not `main`.

## Planning docs

Roadmap items have a plan in `docs/` with Goals, design, a phased **TODO** checklist, Decisions and Open questions. When implementing:
- Read the relevant plan first and follow its Decisions.
- Tick TODO boxes as work lands; move finished roadmap items to **Done** in `ROADMAP.md`.
- Record new decisions in the doc's Decisions table rather than only in code or commit messages.

## Testing

- Backend: pytest in `backend/tests/` (uses `tmp_path`; skips if ffmpeg is missing). Point `DARKROOM_PROJECTS_DIR` at a temp dir for anything that touches storage, or monkeypatch `PROJECTS_DIR` in each module that imported it (see `tests/test_takes.py`, which also stubs `transcribe_file` so no Whisper model is needed).
- Frontend: no unit tests yet; `make lint` and `npm run build` must pass.
- End to end: Playwright can drive the app in Chrome (or the desktop app via `_electron`). Launch with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` to record without real mics (two fake inputs, a full-scale beep each second, so meters show clipping). PATCH the project's `transcribe_model` to `tiny` to keep transcription fast.
- First real transcription downloads the selected Whisper model (hundreds of MB to GBs).

## Known gotchas

- The video full edit (`fullEdit` target) renders EDL segments only and ignores `word_cuts`, unlike the preview proxy and the MP3/WAV export (`_apply_word_cuts` in `renderer.py`).
- `make desktop` needs a built frontend; `make desktop-dev` needs ports 8000 and 5173 free.
- Upload currently reads whole files into memory (`await f.read()`); fine for audio, heavy for large video (planned fix in `docs/fast-transcription.md`).

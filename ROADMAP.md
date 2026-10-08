# Darkroom Roadmap

Where Darkroom is headed. Items move from **Next** to **Done** as they land; anything under **Ideas** is unscheduled and open to discussion.

Each item says why it matters and roughly what it involves, so it can be picked up without extra context.

---

## Principles

The point of Darkroom is that **nothing leaves your control**. Every item below follows these:

- **Local by default.** Recording, transcription, AI editing and rendering run on the user's machine, and work with no cloud set up at all.
- **Cloud is opt-in and stays in your account.** When the user wants more speed or a bigger model, it runs on infrastructure they deploy into **their own account** (AWS, or similar), and their data stays inside that account. There is no shared Darkroom service, and Darkroom never holds user data.
- **No third parties by default.** Cloud AI goes through the user's own account (Bedrock), set up so prompts aren't stored, reviewed or shared. Anything that would send data to a third party is off unless the user knowingly turns it on.
- **Session-scoped and cleaned up.** Cloud resources and data exist only as long as the job or session needs them, then are deleted automatically.
- **Clear about what leaves the machine.** The app says plainly when something will be sent off the computer and where. Today that's only the **Analyse** step, which sends transcript text to the configured AI provider. Bedrock keeps it in the user's AWS account; the direct Anthropic API is a third party, which [Private AI](docs/private-ai.md) makes opt-in and adds a fully local option.

---

## Done

### Desktop app and in-app voice recording

Darkroom runs as an Electron app (`make desktop`) that starts its own backend and closes it on quit. Podcast projects gain a **Record** tab that captures up to 4 microphones at once, one aligned track each, which then flow through the normal transcribe → analyse → edit pipeline.

- Electron shell in `desktop/`, microphone-only permissions, macOS mic prompt
- In-app recording, since replaced by the recording studio (below)
- Streamed WebM recordings converted to FLAC on upload so durations and seeking work

### Recording studio, Phase 1: new project flow and audio-only studio

New Project asks **Upload** (already-synced files; video or audio-only is detected from the files) or **Record**. Record opens a studio with live scrolling waveforms and level meters per mic. Each take streams to disk as it records, survives a crash, and is transcribed as soon as it stops; takes can be reordered and deleted, then joined into per-speaker tracks on **Finish & edit**. Audio-only projects export to **MP3** or **WAV**.

- Studio in `frontend/src/views/Studio.tsx` and `frontend/src/components/Studio/`
- Takes API and transcription worker in `backend/darkroom/api/takes.py`; file handling in `services/takes.py`

### Fast local transcription, Phases 0–1: benchmark and quick wins

A transcription benchmark (solo, 2-mic and 4-mic recordings with real crosstalk) measured speed and word error rate on CPU and an NVIDIA T4, then guided a round of quick wins: VAD skips silence, the model stays loaded between tracks and is preloaded when a project opens or the studio is armed, int8 on CPU and float16 on CUDA, batched decoding, threads set to physical cores, and a default model by device and language (`small` for English on CPU, `turbo` otherwise). A 1-hour, 2-person podcast on CPU went from about 61 minutes to 7 with `small`, under 2 minutes on a T4, with half the error rate. The Apple Silicon baseline is still to do (with the Phase 5 Mac engine).

- Benchmark in `backend/bench/` (results in `bench/results/`); GPU runs via `infra/bench/run-gpu-benchmark.sh`
- Transcription settings in `backend/darkroom/services/transcription.py`; results and decisions in [docs/fast-transcription.md](docs/fast-transcription.md)

---

## Next

### 1. Private AI: local models and a locked-down Bedrock

**Why:** Analyse is the one step where data can leave the user's control. It defaults to the Anthropic API (a third party), there's no local option, and Darkroom doesn't check how the user's Bedrock account retains prompts.

**Involves:** a local AI provider (Ollama/LM Studio/llama.cpp on loopback first, a bundled model later) with JSON-constrained EDL output and an EDL benchmark to pick models; Bedrock checks for zero data retention, region control and models that require retention or human review; the direct Anthropic API made an explicit, labelled opt-in; and the Analyse step saying exactly where the transcript goes.

Full plan, Bedrock data-handling validation and TODO list: **[docs/private-ai.md](docs/private-ai.md)**

### 2. Recording studio and new project flow (Phases 2–7)

**Why:** the studio records microphones only. Video podcasts and screen recordings need cameras, screens and recording more from the editor, and most shows need intro music and sound effects.

**Involves:** New Project asks **Upload** (already-synced files) or **Record**. Record supports audio only or video + audio, with microphones, cameras and multiple screens. Recording happens in a studio view with live scrolling waveforms (and camera/screen previews for video). Each take is written to disk as it records, transcribed as soon as it stops, and you can keep recording more takes, including later from the editor. Music and sound effects (intros/outros, ducked beds, stingers) are placed on their own tracks in the editor and mixed in at render; a studio soundboard comes later. **Studio sound** cleans up voices locally: AI noise removal, de-essing, EQ and level matching between speakers.

Full plan, mockups and TODO list: **[docs/recording-studio.md](docs/recording-studio.md)**

### 3. Fast local transcription (Phases 2–7)

**Why:** Descript and Riverside have transcripts ready moments after an upload or recording ends. Darkroom still transcribes each mic's whole track, one after another, and only after each take or upload ends.

**Involves:** transcribing each mic only where its speaker is talking, transcribing while recording so the transcript is ready seconds after Stop, path-based uploads in the desktop app, and a GPU engine for Apple Silicon. Everything stays local by default; an opt-in mode can use GPUs in the user's own cloud account (AWS or similar).

Full plan, analysis and TODO list: **[docs/fast-transcription.md](docs/fast-transcription.md)**

### 4. Unsynced media on the timeline

**Why:** Upload only works for files that all start at the same moment. Footage from separate devices, or B-roll and inserts, can't be used today.

**Involves:** uploading files into an existing project and placing them on the timeline: drag to position, auto-sync by audio where possible (cross-correlation, as planned for remote guests), and render support for clips that don't span the whole edit.

### 5. Installable desktop builds

**Why:** the desktop app currently needs a repo checkout plus `make install`. Most podcasters won't have Python, Node and FFmpeg set up.

**Involves:**
- Bundling the backend as a standalone executable (e.g. PyInstaller), including faster-whisper and its native dependencies
- Shipping an FFmpeg build with the app, or a guided first-run install
- Downloading Whisper models on first use with visible progress, instead of silently during the first transcription
- Storing projects in the OS app-data folder (`app.getPath('userData')`) rather than the repo's `projects/`
- Packaging with electron-builder or Electron Forge for `.dmg`, `.exe` and `.AppImage`

### 6. macOS signing and notarization

**Why:** a packaged, unsigned app can't reliably get microphone, camera or screen recording permission on macOS, and Gatekeeper blocks it by default.

**Involves:** hardened runtime with the `com.apple.security.device.audio-input` and `com.apple.security.device.camera` entitlements, `NSMicrophoneUsageDescription` and `NSCameraUsageDescription` in `Info.plist`, Screen Recording permission guidance, code signing and notarization in CI. Windows code signing as a follow-on.

### 7. Multi-channel audio interfaces

**Why:** a common podcast setup is one USB interface (e.g. Focusrite Scarlett 2i2) with a mic on each input. The browser sees that as a single stereo device, so both people end up in one track.

**Involves:** letting a recorder track pick a channel of a multi-channel device (split with a Web Audio `ChannelSplitterNode`, or with FFmpeg on upload), so each input becomes its own participant.

### 8. Remote guests

**Why:** many podcasts have guests who aren't in the room. Today every participant needs a mic plugged into the host's computer.

**Involves:** a "double-ender": guests join from a link in their browser, talk to the host over a live WebRTC call, and each side records locally at full quality. Guest tracks upload encrypted while recording, with a live % uploaded for each guest and for the host across all participants; then the host's app downloads, aligns and adds them to the project. The cloud side exists only for the session and runs in the user's own AWS account (serverless recommended, ephemeral instance as an alternative).

Full plan, options comparison and TODO list: **[docs/remote-guests.md](docs/remote-guests.md)**

### 8. Audiograms

**Why:** audio-only podcasts need a video for YouTube and social. Today that means a hand-written FFmpeg script with colours and positions hardcoded.

**Involves:** an audiogram export with a visual layout editor: background or cover art, animated audio bars, text with per-episode variables, captions and a progress bar, each draggable and styleable. Reusable templates with layouts for 16:9, 1:1 and 9:16; full episode or clips; rendered locally from the edited mix with FFmpeg.

Full plan, layout model and TODO list: **[docs/audiograms.md](docs/audiograms.md)**

---

## Ideas

Not scheduled yet. Add to this list freely.

- **Pause and resume** within a take, keeping tracks aligned (takes in the recording studio may cover most of this).
- **Input gain and monitoring:** per-track gain, clip warnings, and optional headphone monitoring.
- **Auto-update** for the desktop app.

# Darkroom Roadmap

Where Darkroom is headed. Items move from **Next** to **Done** as they land; anything under **Ideas** is unscheduled and open to discussion.

Each item says why it matters and roughly what it involves, so it can be picked up without extra context.

---

## Done

### Desktop app and in-app voice recording

Darkroom runs as an Electron app (`make desktop`) that starts its own backend and closes it on quit. Podcast projects gain a **Record** tab that captures up to 4 microphones at once, one aligned track each, which then flow through the normal transcribe → analyse → edit pipeline.

- Electron shell in `desktop/`, microphone-only permissions, macOS mic prompt
- Recorder in `frontend/src/components/Recorder/`
- Streamed WebM recordings converted to FLAC on upload so durations and seeking work

---

## Next

### 1. Installable desktop builds

**Why:** the desktop app currently needs a repo checkout plus `make install`. Most podcasters won't have Python, Node and FFmpeg set up.

**Involves:**
- Bundling the backend as a standalone executable (e.g. PyInstaller), including faster-whisper and its native dependencies
- Shipping an FFmpeg build with the app, or a guided first-run install
- Downloading Whisper models on first use with visible progress, instead of silently during the first transcription
- Storing projects in the OS app-data folder (`app.getPath('userData')`) rather than the repo's `projects/`
- Packaging with electron-builder or Electron Forge for `.dmg`, `.exe` and `.AppImage`

### 2. macOS signing and notarization

**Why:** a packaged, unsigned app can't reliably get microphone permission on macOS, and Gatekeeper blocks it by default.

**Involves:** hardened runtime with the `com.apple.security.device.audio-input` entitlement, `NSMicrophoneUsageDescription` in `Info.plist`, code signing and notarization in CI. Windows code signing as a follow-on.

### 3. Crash-safe recording

**Why:** recordings are held in memory until **Stop** (about 57 MB per track per hour). A crash, power loss or accidental quit during a long session loses everything.

**Involves:** streaming `MediaRecorder` chunks to disk as they arrive (via the Electron preload bridge, or a chunked upload endpoint for the browser), and offering to recover an interrupted session on next launch.

### 4. Multi-channel audio interfaces

**Why:** a common podcast setup is one USB interface (e.g. Focusrite Scarlett 2i2) with a mic on each input. The browser sees that as a single stereo device, so both people end up in one track.

**Involves:** letting a recorder track pick a channel of a multi-channel device (split with a Web Audio `ChannelSplitterNode`, or with FFmpeg on upload), so each input becomes its own participant.

---

## Ideas

Not scheduled yet. Add to this list freely.

- **Recording for video projects:** capture camera + mic together so video projects can be recorded in-app too.
- **Pause and resume** during a recording, keeping tracks aligned.
- **Input gain and monitoring:** per-track gain, clip warnings, and optional headphone monitoring.
- **Auto-update** for the desktop app.
- **Remote guests:** record a guest over the network with each side recording locally and uploading afterwards (needs a lot of design; at odds with "nothing leaves your machine" unless peer-to-peer).

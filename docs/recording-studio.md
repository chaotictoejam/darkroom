# Recording Studio and New Project Flow: Plan

Status: **planned**, not started. Tracked in [ROADMAP.md](../ROADMAP.md).

Turn recording from a tab on the podcast setup screen into a first-class way to start a project: a dedicated studio where you see exactly what is being captured (live waveforms for audio, live previews for cameras and screens), record a take, stop, have it transcribed straight away, and keep recording more takes until you're ready to edit.

---

## Goals

- **New Project starts with one question: Upload or Record.**
- **Record** supports audio only, or video + audio, with any mix of microphones, cameras and **multiple screens**.
- Recording happens in a **studio view** that shows what is being captured: scrolling waveforms per mic (in the style of Audacity or Descript), live previews per camera and screen.
- **Stop → transcribe → record more.** Each take is transcribed in the background as soon as it stops, and you can keep adding takes. You can come back and record more from the editor too.
- **Upload** stays the path for footage that is **already synced** (all files start at the same moment), exactly as today.
- Recordings are written to disk as they happen, so a crash loses seconds, not the session. (This absorbs the "Crash-safe recording" roadmap item, which becomes a must-have once video is involved: an hour of 1080p is several GB.)

## Non-goals (for this plan)

- **Unsynced uploads** (files that need lining up, or B-roll dropped onto the timeline and moved around). That's its own roadmap phase: [Unsynced media on the timeline](../ROADMAP.md).
- Remote guests. Planned separately in [remote-guests.md](remote-guests.md); its participants will appear in this studio once both exist.
- Live streaming.

---

## New project flow

```
New Project
  │  name
  ├── Upload ──► Synced files ── video or audio-only ──► (today's Setup screen) ──► Transcribe ──► Editor
  │
  └── Record ──► Audio only  ─┐
                 Video + audio ┴─► Choose sources ──► Studio ──► takes ──► Editor
```

### Step 1: Upload or Record

```
┌──────────────── New project ────────────────┐
│  Name  [ Episode 12                      ]  │
│                                             │
│  ┌──────────────────┐ ┌──────────────────┐  │
│  │       ⬆          │ │       ●          │  │
│  │     Upload       │ │     Record       │  │
│  │ Files that are   │ │ Mics, cameras    │  │
│  │ already synced   │ │ and screens      │  │
│  └──────────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────┘
```

### Step 2a: Upload

The current Setup screen, with copy that says plainly: *all files must start at the same moment*. Whether the project is video or audio-only is worked out from the files (any file with a video stream → video project), so the user isn't asked twice.

### Step 2b: Record → what to capture

```
┌──────────── What are you recording? ────────────┐
│  ( ) Audio only        (•) Video + audio         │
└──────────────────────────────────────────────────┘
```

### Step 3: Choose sources

One list of sources, each with a live meter or thumbnail so the user can see it's the right device before entering the studio.

| Source | Options | Notes |
|---|---|---|
| **Microphone** | device, participant name, input channel (for multi-channel interfaces) | Each mic is a participant and gets transcribed. Up to 4 |
| **Camera** | device, resolution, paired mic | Pairing tells the editor which camera to cut to when that person talks |
| **Screen** | which display or window | Desktop app can capture several screens at once; browser is limited to one. Screens don't count toward the 4-participant limit |

Audio-only projects only show microphones.

---

## The studio

A full-window view inside the main app window. When screens are being recorded, a **pop-out** is offered so the studio can move to its own window (or collapse to the floating control bar) and stay out of the capture. Everything is visible before, during and after recording, so you always know what is being captured.

### Audio only

```
┌─ Episode 12 ─────────────────────────────── ● REC 00:14:32 ─┐
│                                                              │
│  Alice  Shure MV7    ▁▂▅▇▅▃▂▁▁▂▃▅▆▇▆▄▂▁   ▂▃▂▁   ▁▃▅▃▂▁│ ▮▮▮▯  │
│  Bob    Rode NT-USB  ▁▁▁▁▁▂▃▅▇▇▅▃▁▁▁▁▂▅▇▆▄▂▁▁▁▁▁▁▂▃│ ▮▮▯▯  │
│                                                   ▲ now      │
│  Takes: [1 ✓ 12:03] [2 ✓ 08:41] [3 ● recording]              │
│                                                              │
│            [ ■ Stop ]        [ Finish & edit → ]             │
└──────────────────────────────────────────────────────────────┘
```

- One lane per mic: **scrolling waveform** with the newest audio at a fixed playhead, plus a level meter with peak hold and a red clip indicator.
- Lanes keep the whole take, so you can scroll back while recording.
- Big elapsed timer and a clear recording indicator.
- Takes strip along the bottom: each finished take shows its length and transcription status (⏳ transcribing → ✓ ready).

### Video + audio

```
┌─ Episode 12 ─────────────────────────────── ● REC 00:03:10 ─┐
│ ┌──────────┐ ┌──────────┐ ┌──────────────────────────────┐  │
│ │ Cam A    │ │ Cam B    │ │ Screen 1 (2560×1440)         │  │
│ │ Alice    │ │ Bob      │ │                              │  │
│ └──────────┘ └──────────┘ └──────────────────────────────┘  │
│  Alice  ▁▂▅▇▅▃▂▁▁▂▃▅▆▇▆▄▂▁   ▂▃▂▁   ▁▃▅▃▂▁│ ▮▮▮▯             │
│  Bob    ▁▁▁▁▁▂▃▅▇▇▅▃▁▁▁▁▂▅▇▆▄▂▁▁▁▁▁▁▂▃│ ▮▮▯▯             │
│  Takes: [1 ✓ 12:03] [2 ● recording]                         │
│            [ ■ Stop ]        [ Finish & edit → ]            │
└──────────────────────────────────────────────────────────────┘
```

- A grid of live previews for every camera and screen, labelled with its source and paired participant, with the waveform lanes underneath.
- When recording screens, the studio can **collapse to a small floating control bar** (timer, levels, Stop) so it isn't in the way of what's being shared. The desktop app excludes its own windows from screen capture.

### Stop → transcribe → record more

1. **Stop** finalises the take: files are closed and fixed up (duration, seek index) on disk.
2. Transcription of **that take only** starts in the background. Its chip in the takes strip shows progress.
3. The studio is immediately ready for the next take. Sources stay armed.
4. **Finish & edit** goes to the editor. If a take is still transcribing, the editor opens once it's done (with progress shown), or the user can wait in the studio.
5. From the editor, **Record more** reopens the studio with the same sources. New takes are appended to the end of the timeline and to the existing EDL as kept segments, so earlier edits aren't lost.
6. Takes can be **reordered** by dragging in the takes strip, and deleted (with confirmation), before editing. The timeline uses the order in the strip.

---

## How it works

### Takes and the timeline

Each take is stored separately, and the project's tracks are built by joining takes end to end:

```
projects/a1b2c3d4/
├── takes/
│   ├── take_001/  mic_A.wav  mic_B.wav  cam_A.mp4  screen_1.mp4
│   └── take_002/  mic_A.wav  mic_B.wav  cam_A.mp4  screen_1.mp4
└── cam_A_alice.mp4 ...   # joined tracks the editor and renderer already understand
```

- Joining takes into the existing per-speaker files (FFmpeg concat, no re-encode where possible) means the **editor, waveform, EDL and renderer keep working unchanged** for the first version.
- Each take's transcript is stored with the take and shifted by the take's start time on the joined timeline to build `merged_transcript`. Only new takes are transcribed.
- **Reordering takes** rebuilds the joined tracks and recomputes the transcript offsets in the new order; nothing is re-transcribed.
- If a source is added or missing in a later take, its track is padded with silence (audio) or black (video) for that take so every track stays the same length.
- Take boundaries are saved in the project so the editor can show them as dividers on the timeline.

### Writing to disk while recording

- Each source's `MediaRecorder` delivers a chunk every second. Chunks are streamed to the **local backend** (`POST /api/projects/:id/takes/:take/:source/chunk`), which appends them to a file on disk.
- Using the backend rather than the Electron bridge means the same code works in the browser on `localhost`.
- On **Stop**, the backend finalises each file: remuxes video to MP4 with a proper duration (no re-encode where the codec allows) and converts audio to WAV (lossless).
- If the app crashes mid-take, the next launch finds the unfinished take, finalises what was written, and offers to keep it.

### Keeping sources in sync

- All recorders start in the same tick, as the current recorder already does.
- Cameras and screens can lag their audio by tens of milliseconds. Phase 2 measures this per device during the source check and stores an offset that's applied when joining takes.
- A later improvement: auto-detect a clap or slate across sources to correct sync precisely.

### Live waveforms

- An `AudioWorklet` per mic computes the peak for every ~10 ms of audio. The studio draws these to a canvas that scrolls at a fixed speed.
- Peaks are tiny (about 1.4 MB per track per hour), so the whole take stays scrollable in memory.
- After Stop, the editor's existing waveform endpoint takes over for the finished files.

### Desktop app changes

- **Permissions:** allow camera and screen capture for the app's own origin, in addition to the microphone. macOS needs camera (`askForMediaAccess('camera')`) and Screen Recording permission; the studio explains each one when it's missing.
- **Screens:** use `desktopCapturer` with `setDisplayMediaRequestHandler` so the studio can list displays with thumbnails and capture several at once.
- **Studio window:** optional pop-out window and the floating control bar for screen recording, with the app's windows excluded from capture.

---

## TODO

### Phase 1: New flow and audio-only studio
- [ ] New Project modal: name + **Upload** / **Record**; Record asks **Audio only** / **Video + audio**
- [ ] Store `source: "upload" | "record"` on the project; keep `project_type` (`podcast` for audio only, `video` for video)
- [ ] Upload path: today's Setup screen with "must be synced" copy; detect video vs audio from the files
- [ ] Source picker for microphones with names, live meters, duplicate-device warning (reuse from `Recorder`)
- [ ] Backend: takes data model, chunk append endpoint, finalise-on-stop (WAV), recover unfinished takes on startup
- [ ] Studio view (in-app, full window): scrolling waveform lanes via `AudioWorklet` + canvas, level meters with clip indicator, timer
- [ ] Takes strip: per-take length, transcription progress, delete take
- [ ] Drag to reorder takes; rebuild joined tracks and transcript offsets in the new order
- [ ] Per-take transcription job, transcript offset and appended to `merged_transcript` (later: transcribe while recording, see [fast-transcription.md](fast-transcription.md))
- [ ] Join takes into per-speaker tracks; save take boundaries
- [ ] **Finish & edit** handles takes still transcribing
- [ ] **MP3 export** for audio-only projects in the render step
- [ ] Remove the old Record tab from Setup
- [ ] Tests: chunk append, finalise, recovery, take joining, transcript offsets

### Phase 2: Video + audio (cameras)
- [ ] Camera sources: device, resolution, paired mic, live preview
- [ ] Desktop permissions for camera; macOS camera prompt
- [ ] Video chunk recording and finalise to MP4: record H.264 directly where Chromium's MediaRecorder supports it (remux only), otherwise transcode VP9 WebM on Stop
- [ ] Studio preview grid
- [ ] Measure and store per-camera A/V offset during source check
- [ ] Pad missing sources with black/silence when joining takes
- [ ] Map camera ↔ participant so the editor's camera switching works for recorded projects

### Phase 3: Screens and multi-screen
- [ ] Desktop: `desktopCapturer` source list with thumbnails; several screens at once
- [ ] Browser fallback: single screen via `getDisplayMedia`
- [ ] macOS Screen Recording permission flow and explanation
- [ ] Offer pop-out studio window when screens are recorded; floating control bar; exclude app windows from capture
- [ ] Data model for screen tracks (video with no speaker); screens don't count toward the 4-participant limit

### Phase 4: Record more from the editor
- [ ] **Record more** button in the editor reopens the studio with the project's sources
- [ ] Append new takes to the timeline and to the EDL as kept segments without touching existing edits
- [ ] Take dividers on the editor timeline

### Phase 5: Rendering with screens
- [ ] Render layouts for screen + camera: screen full frame, picture-in-picture camera, side by side
- [ ] Let the EDL (and Claude's analysis prompt) choose between camera and screen views
- [ ] Shorts: vertical layouts that include a screen

---

## Decisions

| Question | Decision |
|---|---|
| Pop-out window or in-app view? | **In-app** full-window studio; a **pop-out** is offered when recording screens |
| Do screens count toward the 4-track limit? | **No.** Up to 4 participants (mics), plus any number of screens |
| Can takes be reordered before editing? | **Yes**, by dragging in the takes strip |
| Recording file formats? | **MP4** for video takes, **WAV** for audio takes (lossless, so editing and export don't stack quality loss). **MP3** is offered as an export format. The browser records WebM/Opus; the backend converts on Stop |

## Open questions

- **Pause:** is pause/resume within a take needed, or are takes enough? Takes probably cover most of it.

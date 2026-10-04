# Recording Studio and New Project Flow: Plan

Status: **Phase 1 done** (new project flow and audio-only studio); Phases 2–7 planned, studio soundboard to be planned later. Tracked in [ROADMAP.md](../ROADMAP.md).

Turn recording from a tab on the podcast setup screen into a first-class way to start a project: a dedicated studio where you see exactly what is being captured (live waveforms for audio, live previews for cameras and screens), record a take, stop, have it transcribed straight away, and keep recording more takes until you're ready to edit.

---

## Goals

- **New Project starts with one question: Upload or Record.**
- **Record** supports audio only, or video + audio, with any mix of microphones, cameras and **multiple screens**.
- Recording happens in a **studio view** that shows what is being captured: scrolling waveforms per mic (in the style of Audacity or Descript), live previews per camera and screen.
- **Stop → transcribe → record more.** Each take is transcribed in the background as soon as it stops, and you can keep adding takes. You can come back and record more from the editor too.
- **Upload** stays the path for footage that is **already synced** (all files start at the same moment), exactly as today.
- **Music and sound effects:** intro/outro music, music beds under speech, and stingers or sound effects, placed in the editor after recording (a studio soundboard comes later).
- **Studio sound:** one switch that makes recorded voices sound clean and professional: background noise and hum removed, levels evened out between speakers, harshness tamed. Runs locally.
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

### Music and sound effects

Sounds are kept **separate from the mic tracks** and mixed in at render time, so they never bleed into transcription, can be moved or removed after recording, and get the same loudness treatment as the rest of the mix.

**Library.** Sounds are audio files the user adds (drag and drop or file picker). They are copied into the project (`projects/<id>/sounds/`) and converted to stereo 48 kHz WAV on import, so render never depends on a file elsewhere on disk. A user-level library (in the app's data folder) makes favourite intros and stingers reusable across projects. Darkroom never downloads or bundles third-party music; the UI reminds the user they need the rights to what they add.

**Cues.** Each use of a sound is a cue:

| Kind | Example | Placement |
|---|---|---|
| **Intro / outro** | theme music | Pinned to the start or end of the edited output, optionally overlapping the first/last words with a fade |
| **Bed** | quiet music under a segment | Spans from one point to another, loops if the sound is shorter, **ducks under speech** |
| **Stinger / SFX** | transition whoosh, applause, laugh | One-shot at a point |

Cues inside the episode are anchored to the **source timeline** (a time on the joined tracks, usually snapped to a word boundary) rather than the output, so they move with the content when segments are cut or reordered. A cue whose anchor falls inside a cut snaps to the next kept moment; a bed whose span is partly cut plays only over what is kept.

```json
"sounds": [{"id": "s1", "name": "Intro theme", "file": "sounds/s1.wav", "duration": 12.4}],
"sound_tracks": [{"id": "music", "name": "Music", "gain_db": 0, "muted": false},
                 {"id": "sfx", "name": "SFX", "gain_db": 0, "muted": false}],
"sound_cues": [
  {"id": "c1", "sound_id": "s1", "track": "music", "kind": "intro", "gain_db": -3, "fade_out": 2.0, "overlap": 4.0},
  {"id": "c2", "sound_id": "s2", "track": "sfx", "kind": "sfx", "at": 812.35, "gain_db": -6},
  {"id": "c3", "sound_id": "s3", "track": "music", "kind": "bed", "at": 900.0, "until": 1140.0, "gain_db": -18, "duck": true, "loop": true}
]
```

**In the editor: sound tracks.** Sounds appear as **their own tracks** under the speaker tracks, so music and effects are visually separate from speech. Each track has a name, mute/solo and a track gain; cues sit on a track as blocks with their waveform. Drag to move (or to another track), drag edges to trim beds, click for gain, fades, ducking and loop. A new project starts with a **Music** and an **SFX** track; more can be added. Cues can also be added at the cursor in the transcript ("insert sound here"), onto the selected track. Because cues are anchored to the recording, cutting speech moves the blocks on the sound tracks with it. The preview proxy includes cues so what you hear is what renders.

**Later: studio soundboard.** Firing sounds live while recording is a future phase that needs its own plan (see Open questions). Whatever its design, sounds stay **separate**: they play to the host's headphones and are logged as cues, never played into the mics or baked into the recording.

**Rendering.** After the speech is cut and concatenated, each cue's anchor is mapped through the EDL (and `word_cuts`) to an output time. Cues are positioned with `adelay`, shaped with `afade`/`volume`, beds are ducked with `sidechaincompress` keyed from the speech mix, track gain and mute are applied, and everything is mixed with `amix` **before** the existing `loudnorm`, so the −16 LUFS target covers the whole mix. The same path serves MP3/WAV export, the full video edit and the preview.

**Claude.** Later, the Analyse step can suggest cues (e.g. a stinger at topic changes) using sound **names** only; audio never leaves the machine. Suggestions appear as unconfirmed cues the user accepts or rejects.

### Studio sound (voice enhancement)

One **Studio sound** switch per project (and per speaker track) that turns raw mic recordings into clean, broadcast-style voice, like Descript's Studio Sound or Adobe Podcast Enhance, but **entirely on the machine**. It works for recorded and uploaded projects alike.

**Processing chain, per speaker track, before the tracks are mixed:**

| Step | What it fixes | How (local) |
|---|---|---|
| 1. High-pass | Rumble, desk bumps, AC hum below the voice | FFmpeg `highpass` (~80 Hz) and a hum notch at 50/60 Hz when detected |
| 2. **AI noise removal** | Fans, traffic, keyboard, room tone | **Both engines are supported** and the user picks one: **DeepFilterNet** (Python, runs on CPU in real time, best quality) or FFmpeg `arnndn` (**RNNoise**, built in, lighter). **Auto** (default) uses DeepFilterNet when installed, otherwise RNNoise |
| 3. De-reverb (optional) | Echoey rooms | DeepFilterNet's stronger setting, or a later dedicated model |
| 4. De-ess | Sharp "s" sounds | FFmpeg `deesser` |
| 5. Voice EQ | Muddy or thin voices | Gentle preset EQ (low-mid cut, presence lift) |
| 6. Leveling | One speaker much louder than another; quiet and loud moments | Compression plus per-track loudness matching so every speaker sits at the same level |
| 7. Final loudness | Platform level | The existing mix-level `loudnorm` to −16 LUFS stays as the last step |

**Strength.** One slider (Light / Medium / Strong) maps to denoise amount and leveling. Heavy denoising makes voices sound processed, so the default is Medium, and the dry/wet mix blends some of the original back in.

**Non-destructive and cached.** The original `cam_<id>` tracks are never changed. Enhancement writes `cam_<id>.enhanced.wav` as a background job (same `_update_progress` pattern as other jobs), keyed by a hash of the settings so changing the slider only reprocesses what changed. Render, preview and the editor waveform use the enhanced file when Studio sound is on.

**Hearing the difference.** The editor has an **A/B** toggle (original vs enhanced) on playback, per track, so the user can check nothing important was removed (e.g. quiet laughter treated as noise).

**Silence between words.** After denoising, the gaps between speech are near silent, which can sound unnatural. A low "room tone" floor is kept rather than full digital silence, and the noise gate is soft.

**Interaction with other features.**
- **Transcription** uses the **original** audio (Whisper handles noise well and denoisers can smear consonants). Whether to switch is decided only after comparing transcript accuracy on noisy samples.
- **While recording**, nothing is processed: the headphone monitor and the takes stay raw, and Studio sound runs after recording.
- **Off by default.** After the first take is finalised, the studio offers once: "Make it sound like a studio?" Turning it on there sets the project setting.
- **Music and sound effects** (Phase 6) are never enhanced; only speaker tracks are.
- **Mic bleed** (one person picked up on another's mic) is a related problem; the speaker-aware gating in [fast-transcription.md](fast-transcription.md) can be reused later to duck a track while its speaker is silent.

**Local by default.** Everything above runs on the user's machine. DeepFilterNet is an optional install (`pip install` extra); the engine picker shows it as unavailable until it's installed, and Auto falls back to RNNoise and says so in the UI. A heavier model on a GPU in the user's own cloud account could come later under the opt-in cloud plan, never a third-party service.

### Desktop app changes

- **Permissions:** allow camera and screen capture for the app's own origin, in addition to the microphone. macOS needs camera (`askForMediaAccess('camera')`) and Screen Recording permission; the studio explains each one when it's missing.
- **Screens:** use `desktopCapturer` with `setDisplayMediaRequestHandler` so the studio can list displays with thumbnails and capture several at once.
- **Studio window:** optional pop-out window and the floating control bar for screen recording, with the app's windows excluded from capture.

---

## TODO

### Phase 1: New flow and audio-only studio
- [x] New Project modal: name + **Upload** / **Record**; Record asks **Audio only** / **Video + audio**
- [x] Store `source: "upload" | "record"` on the project; keep `project_type` (`podcast` for audio only, `video` for video)
- [x] Upload path: today's Setup screen with "must be synced" copy; detect video vs audio from the files
- [x] Source picker for microphones with names, live meters, duplicate-device warning (reuse from `Recorder`)
- [x] Backend: takes data model, chunk append endpoint, finalise-on-stop (WAV), recover unfinished takes on startup
- [x] Studio view (in-app, full window): scrolling waveform lanes via `AudioWorklet` + canvas, level meters with clip indicator, timer
- [x] Takes strip: per-take length, transcription progress, delete take
- [x] Drag to reorder takes; rebuild joined tracks and transcript offsets in the new order
- [x] Per-take transcription job, transcript offset and appended to `merged_transcript` (later: transcribe while recording, see [fast-transcription.md](fast-transcription.md))
- [x] Join takes into per-speaker tracks; save take boundaries
- [x] **Finish & edit** handles takes still transcribing
- [x] **MP3 export** for audio-only projects in the render step
- [x] Remove the old Record tab from Setup
- [x] Tests: chunk append, finalise, recovery, take joining, transcript offsets

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

### Phase 6: Music and sound effects
- [ ] Data model: `sounds`, `sound_tracks` and `sound_cues` on the project (`new_project()` + `_DEFAULTS`); import endpoint copies and converts to stereo 48 kHz WAV in `sounds/`
- [ ] Sound library panel: add, rename, preview, delete; rights reminder on import
- [ ] Render: map cue anchors through the EDL and word cuts; mix cues (delay, gain, fades, loop, track gain/mute) before `loudnorm` in audio export, full video edit and preview
- [ ] Intro/outro cues pinned to output start/end with overlap and fade
- [ ] Beds with ducking under speech (`sidechaincompress`)
- [ ] Editor: sound tracks under the speaker tracks (default Music + SFX, add/rename/delete, mute/solo, track gain); cue blocks with waveform, drag to move or change track, trim, gain/fade/duck/loop controls; "insert sound here" from the transcript
- [ ] User-level sound library shared across projects
- [ ] Tests: import/convert, anchor mapping through cuts (including anchors inside a cut and partly cut beds), mix filter graph, track mute/gain
- [ ] Later: Claude suggests cues from sound names, shown as unconfirmed

### Phase 7: Studio sound (voice enhancement)
- [ ] Project and per-track settings: `studio_sound` (on/off, strength, engine `auto` | `deepfilternet` | `rnnoise`) in `new_project()` + `_DEFAULTS`; off by default
- [ ] Enhancement service: high-pass + hum notch, denoise, de-ess, voice EQ, compression, per-track loudness matching; writes cached `cam_<id>.enhanced.wav`
- [ ] Denoise engines: DeepFilterNet as an optional extra and `arnndn` with a bundled RNNoise model; engine picker with Auto (DeepFilterNet if installed, else RNNoise); report which engine is in use
- [ ] Background enhancement job with progress; re-run only for tracks whose settings changed
- [ ] Render, preview proxy, MP3/WAV export and editor waveform use the enhanced track when on
- [ ] Editor UI: Studio sound switch, strength slider, engine picker, per-track override, A/B playback
- [ ] Studio: one-time prompt after the first take is finalised offering to turn Studio sound on
- [ ] Compare transcript accuracy (original vs enhanced, both engines) on noisy samples to decide whether transcription should use enhanced audio
- [ ] Keep a low room-tone floor between words instead of hard silence
- [ ] Tests: filter chain builds, cache invalidation on settings change, fallback when DeepFilterNet is missing, loudness matching brings tracks within ~1 LU
- [ ] Later: de-reverb, mic-bleed reduction using speaker activity, optional GPU engine in the user's own cloud

---

## Decisions

| Question | Decision |
|---|---|
| Pop-out window or in-app view? | **In-app** full-window studio; a **pop-out** is offered when recording screens |
| Do screens count toward the 4-track limit? | **No.** Up to 4 participants (mics), plus any number of screens |
| Can takes be reordered before editing? | **Yes**, by dragging in the takes strip |
| Recording file formats? | **MP4** for video takes, **WAV** for audio takes (lossless, so editing and export don't stack quality loss). **MP3** is offered as an export format. The browser records WebM/Opus; the backend converts on Stop |
| WAV parameters for takes? | **Mono, 48 kHz, 16-bit PCM** for every mic, so joining takes is a straight concat and tracks stay sample-aligned |
| When are takes joined into tracks? | On **Finish & edit**, in the takes strip order (`cam_<id>.wav`). Reordering before that only changes the order; nothing is re-transcribed |
| How many takes transcribe at once? | **One.** A single background worker, since each transcription loads a Whisper model and they would compete for CPU/GPU and memory |
| Chunk upload integrity? | Each chunk carries its byte **offset**. The backend accepts a resend of a chunk it already has and refuses a gap; while the backend is unreachable, chunks wait in memory and are retried |
| What happens to a take after a crash? | On startup it is finalised from what reached disk and flagged **recovered**; the studio offers **Keep** or **Delete** |
| Video + audio in the New Project modal before Phase 2? | Shown, but **disabled** ("coming soon") |
| Music and sounds: editor or studio first? | **Editor first** (Phase 6). A studio soundboard is a later phase that needs its own planning |
| Can sounds play into the mics so guests hear them? | **No.** Sounds always stay separate from the mic recordings and are mixed in at render |
| What are sound cues anchored to? | **The recording** (source timeline), so they move with the content when speech is cut or reordered |
| How are sounds shown in the editor? | As **separate sound tracks** (default Music and SFX) under the speaker tracks |
| Studio sound on by default? | **Off.** The studio offers to turn it on once, after the first take |
| Transcribe from enhanced audio? | **No, original** for now. Revisit after comparing transcript accuracy on noisy samples |
| Studio sound live while recording? | **No.** Processing runs only after recording; the monitor and takes stay raw |
| Which noise-removal engine? | **Both.** DeepFilterNet (optional install, best quality) and RNNoise via FFmpeg `arnndn` (always available). The user picks; **Auto** uses DeepFilterNet when installed, otherwise RNNoise |
| Audio export formats? | **MP3** (192 kbps) and **WAV** (lossless master). Both apply the EDL, word cuts and word mutes, and normalise to −16 LUFS |

## Open questions

- **Studio soundboard (future phase):** pad layout and shortcuts, headphone-only vs also into a remote guest's feed ([remote-guests.md](remote-guests.md)), how logged cues follow take reordering, and whether the host needs a monitor mix of mics + sounds.
- **Pause:** is pause/resume within a take needed, or are takes enough? Takes probably cover most of it.

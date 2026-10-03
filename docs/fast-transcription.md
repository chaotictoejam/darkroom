# Fast Local Transcription: Plan

Status: **planned**, not started. Tracked in [ROADMAP.md](../ROADMAP.md).

Descript and Riverside have transcripts ready within moments of an upload or recording finishing. This plan covers how they get there, where Darkroom's time goes today, and how to get close to that speed **while keeping transcription on the user's machine**, plus an opt-in mode that uses GPUs in the user's **own** cloud account.

---

## How Descript and Riverside do it

Broadly, from how the products behave (neither publishes its full pipeline):

1. **The audio is already there when you stop.** Riverside uploads each participant's track progressively *during* recording, and Descript uploads in the background while you carry on working. By the time you press Stop or the upload finishes, most of the audio has already been processed.
2. **Work is split and run in parallel.** Long recordings are cut into chunks (at pauses) and transcribed at the same time across many GPUs, so a one-hour file takes roughly as long as its slowest chunk, not an hour of compute.
3. **Silence is skipped.** Voice activity detection (VAD) means only actual speech is sent to the speech model.
4. **Fast models on GPUs.** Modern speech models running on data-centre GPUs transcribe many times faster than real time.
5. **Results stream in.** The transcript appears section by section, so it *feels* finished before it actually is.

Darkroom can't use a data centre, but points 1, 3 and 5 don't need one, and point 2 can be approximated on a single machine with batching.

---

## Where Darkroom's time goes today

From `backend/darkroom/services/transcription.py`:

| Today | Cost |
|---|---|
| Each speaker's **whole track** is transcribed, one after another | A 1-hour, 2-mic podcast is 2 hours of audio to process, even though each mic is mostly silence or crosstalk |
| **No VAD** (`vad_filter` not set) | Whisper processes every silent 30 s window, and then several filters have to remove the hallucinations it produces on silence |
| The model is **loaded again for every track** (`WhisperModel(...)` inside `transcribe_file`) | Several seconds per track, and memory churn |
| `compute_type` left at default | On CPU this runs in float32; int8 is typically around twice as fast with little accuracy loss |
| Default model is **`medium`** | `turbo` (large-v3-turbo) and `distil-large-v3.5` are faster with similar or better accuracy |
| No **batched** inference | `BatchedInferencePipeline` (available in the installed faster-whisper 1.2.1) decodes many chunks at once |
| Transcription starts only **after** upload or recording ends | Nothing overlaps; a long recording means a long wait after Stop |
| Uploads copy files **through HTTP**, and the backend reads the whole file into memory | For multi-GB video this is slow before transcription even starts |
| Progress is a **time estimate**, and the transcript appears only at the end | Feels slower than it is |

**Rough estimate** (to be measured in Phase 0): a 1-hour, 2-person podcast on an 8–12 core CPU with `medium` today takes in the region of 20–30 minutes. With the quick wins below it should come down to a few minutes; with live transcription during recording, to seconds after Stop.

---

## The plan

### 1. Quick wins (small code changes, biggest gains)

- **Turn on VAD** (`vad_filter=True`, Silero VAD, already bundled with faster-whisper). Skips silence and also removes the main cause of hallucinations.
- **Load each model once** and keep it in memory between tracks and jobs; preload it in the background when a project is opened or the studio is armed.
- **int8 on CPU, float16 on NVIDIA GPU** (`compute_type="int8"` / `"float16"`), chosen automatically.
- **Use `BatchedInferencePipeline`.** Speech regions found by VAD are decoded in batches: a large speed-up on GPU, a smaller one on CPU.
- **Default model `turbo`** instead of `medium`, keeping the picker for users who want something else.
- **Real progress:** report progress from the end time of each segment as it's produced, instead of a time-based guess.

### 2. Only transcribe each mic where its speaker is talking

With one mic per person, most of each track is that person *not* talking: silence, or someone else's voice bleeding in.

- Run VAD on every track, then compare loudness across tracks moment by moment. A region is assigned to the mic where it's loudest (the person actually speaking), and crosstalk on the other mics is dropped.
- Each track is transcribed **only in its own speaker's regions**. Total audio processed becomes roughly the length of the episode, not the episode × the number of mics.
- Overlapping speech (both people talking at once) keeps both regions, so nothing is lost.
- Bonus: this also improves speaker attribution and removes duplicate words picked up from the other person's mic.

### 3. Transcribe while recording

Ties in with the [recording studio](recording-studio.md), which already writes each take to disk as it records.

- A background worker follows each mic's file as it grows. Whenever VAD finds a finished stretch of speech (a pause after talking), that stretch is transcribed straight away.
- At **Stop**, only the last few seconds are left, so the take's transcript is ready almost immediately.
- Optional: show the live transcript in the studio as it's produced.
- **Safety valve:** recording must never stutter. The worker runs at low priority, and if it can't keep up (measured as a real-time factor), it pauses and catches up after Stop. On slower machines it can use a smaller model live and offer to re-run with a larger one afterwards.

### 4. Faster uploads

- **Desktop app: no HTTP upload for local files.** The app passes the file's path to the backend, which copies it on disk (or references it in place, by user choice). Multi-GB video becomes a file copy instead of an HTTP upload.
- **Start each track as soon as it lands**, rather than waiting for all files.
- **Browser:** stream uploads to disk instead of reading the whole file into memory.
- Audio is extracted from video with FFmpeg in parallel with the copy.

### 5. Use the hardware the user has

| Hardware | Today | Plan |
|---|---|---|
| NVIDIA GPU | faster-whisper on CUDA (if CUDA libraries are installed) | float16 + batched pipeline; check CUDA/cuDNN at startup and say clearly if the GPU isn't being used |
| Apple Silicon Mac | **CPU only**: faster-whisper has no Metal support | Add an engine that uses the Mac GPU: **mlx-whisper** or **whisper.cpp** (Metal / Core ML). Many podcasters use Macs, so this matters |
| CPU only | float32, one track at a time | int8, VAD, batching; use all cores |

To support this, put transcription behind a small **engine interface** (input: audio + options; output: the same segment and word format as today), so faster-whisper, mlx-whisper and whisper.cpp can be swapped without touching the rest of the app.

A short **benchmark on first run** (a few seconds of bundled audio) measures the machine's speed, picks the default model and engine, and replaces the hard-coded speed table used for progress.

### 6. Feel faster

- **Stream segments to the UI** over the existing WebSocket as they're produced, so the transcript fills in while the job runs.
- Let the user **start reading and editing the parts already transcribed** while the rest finishes.

### 7. Optional: transcription in the user's own cloud

For people on slow machines, or with very long recordings, an **opt-in** cloud mode can do what Descript and Riverside do: split the audio and transcribe the pieces on several GPUs at once. It follows the roadmap's [principles](../ROADMAP.md#principles): the user deploys it into **their own AWS account (or a similar provider)**, so the data stays in their control, and Darkroom never runs a shared service. Local transcription stays the default and keeps working without it.

**How it works**

```
 Darkroom (desktop)                         User's own cloud account
 ──────────────────                         ────────────────────────
 VAD → speech-only audio, compressed (Opus)
 split at pauses, encrypt ──── upload ───►  storage bucket (job prefix, auto-expiry)
                                                 │
                                            job starts N GPU workers
                                            each transcribes some chunks
                                                 │
 download + decrypt results ◄────────────── results (encrypted)
 stitch chunks, map timestamps back         job ends: workers stop, objects deleted
```

- **Only speech is sent:** after VAD and per-mic gating (sections 1–2), and compressed, so uploads are small.
- **Encrypted end to end:** chunks are encrypted on the user's machine; the GPU worker gets a per-job key, and nothing is stored unencrypted.
- **Exists only for the job:** workers start for the job and shut down when it's done; uploaded audio and results are deleted after download, with storage expiry rules as a backstop.
- **Same output as local:** the worker runs the same engine and settings, so the transcript format and quality match local transcription.
- **Can overlap with recording:** combined with section 3, chunks can be sent during a recording so the transcript is ready at Stop, as Riverside does.

**Hosting options** (decide in a spike; same "only exists for the job" idea as the [remote guests](remote-guests.md) session stack)

| Option | Notes |
|---|---|
| GPU instances started per job (EC2 Spot or on-demand, or AWS Batch) | Cheapest per hour; 1–3 min to start; workers terminate themselves when the queue is empty |
| SageMaker asynchronous inference, scaled to zero | Managed queue and scaling; still has GPU cold starts |
| Serverless GPU in the user's own account on another provider (e.g. Modal, RunPod) | Fast cold starts and simple setup; for users who don't use AWS |

The deployment is a CDK stack in `infra/` alongside the existing ones, and the app reads its endpoint from `.env`. Local and cloud engines sit behind the same engine interface (section 5), so the rest of the app doesn't change.

**Cost** (to be measured): GPU time is billed per second, and Whisper-class models on a modern GPU run many times faster than real time, so an hour-long episode should cost in the region of cents. Idle cost is zero.

---

## Expected impact

| Change | Effort | Likely gain |
|---|---|---|
| VAD + int8 + model loaded once | Small | Large: about 2× from int8, plus all silence skipped |
| `turbo` as default model | Tiny | Large compared with `medium` |
| Batched pipeline | Small | Large on GPU, moderate on CPU |
| Per-mic speaker gating | Medium | Divides work by roughly the number of mics |
| Transcribe while recording | Medium–large | Transcript ready seconds after Stop |
| Desktop path-based uploads | Small | Removes the upload wait for large video |
| Apple Silicon GPU engine | Medium | Large on Macs |
| Streaming segments to UI | Small | Perceived speed |
| Optional self-hosted cloud GPUs | Large | Near-instant on any machine, for users who opt in |

All "likely gain" figures are to be confirmed by the Phase 0 benchmark.

---

## TODO

### Phase 0: Benchmark
- [ ] Benchmark script: fixed test set (solo, 2-mic and 4-mic recordings with real crosstalk, 10–60 min) → wall time, real-time factor and word error rate per configuration
- [ ] Baseline today's settings on CPU, NVIDIA GPU and Apple Silicon
- [ ] Record results in this doc and use them to confirm the default model

### Phase 1: Quick wins
- [ ] `vad_filter=True`; review which hallucination filters are still needed afterwards
- [ ] Model cache: load once per (model, device, compute type), reuse across tracks and jobs
- [ ] Automatic `compute_type`: int8 on CPU, float16 on CUDA
- [ ] `BatchedInferencePipeline` with a batch size chosen from available memory
- [ ] Default model → `turbo`; update Setup labels and README
- [ ] Progress from produced segment times instead of the speed table
- [ ] Preload the model when a project is opened or the studio is armed

### Phase 2: Per-mic speaker gating
- [ ] VAD per track + cross-track loudness comparison → speech regions per speaker
- [ ] Transcribe only each speaker's regions; map timestamps back to the full track
- [ ] Keep overlapping speech for both speakers
- [ ] Compare accuracy and speed against full-track transcription on the Phase 0 set

### Phase 3: Transcribe while recording (with the recording studio)
- [ ] Background worker that follows growing take files and transcribes finished speech regions
- [ ] Low priority + real-time factor monitor; pause and catch up after Stop if behind
- [ ] Optional live transcript in the studio
- [ ] Take transcript finalised within seconds of Stop

### Phase 4: Faster uploads
- [ ] Desktop: pass file paths through the preload bridge; copy or reference in place
- [ ] Browser: stream uploads to disk instead of `await f.read()`
- [ ] Start transcribing each track as soon as it arrives

### Phase 5: Engines and hardware
- [ ] Engine interface; move faster-whisper behind it
- [ ] Apple Silicon engine (mlx-whisper or whisper.cpp, chosen by benchmark)
- [ ] CUDA availability check with a clear message when the GPU can't be used
- [ ] First-run benchmark that picks the engine and default model

### Phase 6: Streaming results
- [ ] Push segments over the WebSocket as they're produced
- [ ] Editor shows and allows editing of finished parts while transcription continues

### Phase 7: Optional cloud transcription (self-hosted)
- [ ] Spike: compare per-job GPU instances, SageMaker async and a non-AWS serverless GPU on cold start, speed and cost
- [ ] CDK stack: storage bucket with expiry rules, job queue, GPU worker image with the same engine as local, IAM scoped to the job
- [ ] Desktop: split speech-only audio at pauses, compress, encrypt, upload, download and stitch results
- [ ] Per-job encryption keys; delete uploads and results after download
- [ ] Workers and any job resources shut down automatically when the job is done or times out
- [ ] Settings: off by default; clear notice of what is sent and where; fall back to local if the cloud stack is unreachable
- [ ] Optional: send chunks during recording so the transcript is ready at Stop
- [ ] Cost estimate from real jobs, added to the README Costs section

---

## Open questions

- **Default model:** `turbo` or `distil-large-v3.5`? Distil models are English-focused; `turbo` is multilingual. Decide from the Phase 0 results.
- **Live transcript in the studio:** useful to see, or distracting while recording? Could be a toggle.

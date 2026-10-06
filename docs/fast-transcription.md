# Fast Local Transcription: Plan

Status: **in progress**: Phase 1 (quick wins) done; Phase 0 benchmark done on CPU (see [Phase 0 results](#phase-0-results-cpu)). Tracked in [ROADMAP.md](../ROADMAP.md).

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
| `compute_type` left at default | On CPU this runs in float32; int8 measured 1.15–1.2× faster in Phase 0, with no accuracy loss |
| Default model is **`medium`** | `turbo` (large-v3-turbo) and `distil-large-v3.5` are faster with similar or better accuracy |
| No **batched** inference | `BatchedInferencePipeline` (available in the installed faster-whisper 1.2.1) decodes many chunks at once |
| Transcription starts only **after** upload or recording ends | Nothing overlaps; a long recording means a long wait after Stop |
| Uploads copy files **through HTTP**, and the backend reads the whole file into memory | For multi-GB video this is slow before transcription even starts |
| Progress is a **time estimate**, and the transcript appears only at the end | Feels slower than it is |

**Measured in Phase 0** (Ryzen 5 3600, 6 cores): a 1-hour, 2-person podcast with `medium` and the old settings took about **61 minutes**, not the 20–30 first estimated. With the Phase 1 settings it takes about 28 minutes with `turbo`, or 9 with `small`; with live transcription during recording, it should come down to seconds after Stop.

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

All "likely gain" figures are to be confirmed by the Phase 0 benchmark; the CPU results are below.

---

## Phase 0 results (CPU)

Measured on 4 Oct 2026 on an AMD Ryzen 5 3600 (6 cores, 12 threads, 32 GB, no usable GPU) with faster-whisper 1.2.1. Script: [`backend/bench/transcription.py`](../backend/bench/transcription.py); raw results (no transcripts): [`backend/bench/results/ryzen5-3600.jsonl`](../backend/bench/results/ryzen5-3600.jsonl). NVIDIA and Apple Silicon runs are still to do. To run the benchmark yourself, locally or on AWS GPU and Mac instances, see [`backend/bench/README.md`](../backend/bench/README.md).

**Test set** (public, with human reference transcripts; 75 min of audio, 7 tracks): solo = one TED talk (TED-LIUM 3 long-form, 15 min); 2-mic = AMI TS3003b 25:00–35:00, the two speakers in conversation; 4-mic = AMI ES2004a 7:00–17:00, all four headsets. AMI headsets have real crosstalk.

**WER** is reported two ways: everything transcribed on each mic (crosstalk from other speakers counts as insertions), and in brackets with crosstalk excluded (only words inside the speaker's own reference speech, the best a Phase 2 gate could do). Speed is × real time, including model load.

| Config | Solo | 2-mic | 4-mic | Overall speed | Pooled WER, crosstalk excluded | Peak RAM |
|---|---|---|---|---|---|---|
| Before Phase 1 (`medium`, float32, no VAD) | 1.53× · 1.8% | 1.98× · 65.9% (29.8%) | 2.27× · 36.1% (35.4%) | 2.00× | 19.7% | 8.0 GB |
| Phase 1, `large-v3` | 1.59× · 1.9% | 2.70× · 36.5% (14.7%) | 5.49× · 16.5% (15.4%) | 3.11× | 9.5% | 8.1 GB |
| Phase 1, `turbo` (default) | 2.74× · 2.1% | 4.27× · 37.3% (14.8%) | 9.43× · 16.0% (15.2%) | 5.20× | 9.5% | 3.6 GB |
| Phase 1, `distil-large-v3.5` | 2.81× · 1.7% | 4.36× · 60.5% (15.1%) | 9.60× · 17.0% (13.0%) | 5.31× | 8.7% | 3.6 GB |
| Phase 1, `medium` | 2.85× · 2.0% | 4.88× · 31.2% (16.1%) | 9.70× · 15.4% (14.8%) | 5.55× | 9.7% | 5.0 GB |
| Phase 1, `small` | 7.83× · 2.1% | 12.85× · 33.2% (15.4%) | 26.38× · 16.1% (15.7%) | 15.01× | 9.8% | 2.4 GB |
| Phase 1, `base` | 23.64× · 2.9% | 39.81× · 41.0% (16.3%) | 74.23× · 19.3% (17.2%) | 44.69× | 10.9% | 1.8 GB |

Ablations on `turbo` (solo / 2-mic speed): float32 sequential no VAD 2.31× / 2.53×; + int8 2.83× / 2.90×; + VAD 2.94× / 3.71×; batched pipeline at batch 1 / 4 / 8 / 16: 2.68–2.78× / 4.62×, 4.37×, 4.27×, 4.18×; batch 8 with 6 threads 3.27× / 5.18×; with 12 threads 3.30× / 4.95×.

What the numbers say:

- **Phase 1 is 2.6× faster overall and halves the error rate** (19.7% → 9.5% crosstalk excluded). The old code missed about a third of the words on the 4-mic tracks (588 of 1,880 deleted): without VAD, Whisper skips short replies surrounded by long silence.
- **On CPU, `turbo` is no faster than `medium`.** It shrinks the decoder but keeps large-v3's encoder, which is the bottleneck on a CPU. `small` is 2.9× faster than `turbo` at the same accuracy.
- **Threads matter more than batching on CPU.** CTranslate2 uses 4 threads by default; 6 (the physical cores) is about 20% faster; 12 adds nothing. Batch sizes above 4 are slightly slower. The batched pipeline's gain on CPU comes from its tighter VAD chunks, not from batching.
- **Crosstalk is now the largest error source:** more than half of every model's errors on the 2-mic item. `distil-large-v3.5` transcribes the most bleed.
- **Bug found:** batched decoding with timestamp tokens dropped whole sentences (fixed; see Decisions).

---

## TODO

### Phase 0: Benchmark
- [x] Benchmark script: fixed test set (solo, 2-mic and 4-mic recordings with real crosstalk, 10–60 min) → wall time, real-time factor and word error rate per configuration
- [x] Baseline on CPU (Ryzen 5 3600)
- [ ] Baseline on an NVIDIA GPU (`infra/bench/run-gpu-benchmark.sh`; needs a G-instance quota increase on the AWS account)
- [ ] Baseline on Apple Silicon (EC2 Mac steps in `backend/bench/README.md`; 24-hour minimum, so best combined with the Phase 5 Mac engine)
- [x] Record results in this doc
- [ ] Confirm the default model: `small` on CPU is recommended (see [Open questions](#open-questions))

### Phase 1: Quick wins
- [x] `vad_filter=True`; review which hallucination filters are still needed afterwards
- [x] Model cache: load once per (model, device, compute type), reuse across tracks and jobs
- [x] Automatic `compute_type`: int8 on CPU, float16 on CUDA
- [x] `BatchedInferencePipeline` with a batch size chosen from available memory
- [x] Default model → `turbo`; update Setup labels and README
- [x] Progress from produced segment times instead of the speed table
- [x] Preload the model when a project is opened or the studio is armed
- [ ] From Phase 0: set `cpu_threads` to the number of physical cores (about 20% faster on CPU)
- [ ] From Phase 0: cap the CPU batch size at 4, and re-measure together with the thread change

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

## Decisions

| Question | Decision |
|---|---|
| How many models stay loaded? | **One**, the most recently used. Switching model evicts the old one (a job still using it keeps its reference until done). Holding every model a user tries could use several GB of RAM |
| Which hallucination filters are still needed with VAD? | **All kept.** VAD removes the main cause (silence), but the filters are cheap and still catch loops in real speech. The `no_speech_prob` filter now uses Whisper's own rule (`no_speech_prob > 0.5` **and** `avg_logprob < -1.0`), because the batched pipeline reports `no_speech_prob` per 30 s chunk and on its own would drop real speech next to a pause |
| Segment granularity with the batched pipeline | Decode **without timestamp tokens** (`without_timestamps=True`) and split each chunk into sentences from word times (at `.` `?` `!` or a pause of 1 s or more). Phase 1 first used `without_timestamps=False`, but the batched pipeline decodes each chunk once, so speech after the last timestamp was dropped: whole sentences on the Phase 0 solo talk |
| Compute type when CUDA has no float16 | Next supported of `int8_float16`, `float32`. If the model can't load on CUDA at all (e.g. cuBLAS/cuDNN missing), fall back to CPU int8 and log it; a user-facing message is Phase 5 |
| Batch size | From memory: CPU 2 / 4 / 8 for < 8 / 8–16 / ≥ 16 GB RAM (4 if unknown, e.g. Windows); CUDA 4 / 8 / 16 for < 4 / 4–8 / ≥ 8 GB free VRAM via `nvidia-smi` (8 if unknown). Phase 0 found batches above 4 slightly slower on CPU; a cap of 4 is planned |
| When to preload, and may preloading download? | Setup preloads the selected model **only if it's already downloaded**, so browsing the picker never starts a multi-GB download. Entering the studio preloads **and downloads** if needed, since the first take is transcribed as soon as it stops. Endpoint: `POST /api/transcription/preload` `{model, download}` |
| Default model | **`turbo`** for now (multilingual). Phase 0 shows `small` matches its accuracy at 2.9× the speed on CPU; the choice is open (see Open questions) |
| Benchmark test set | Public recordings with human references: one TED talk (solo) and AMI headset meetings (2-mic, 4-mic, real crosstalk). Audio and transcripts stay in `~/.cache/darkroom/bench`; only timings and scores are committed, since TED-LIUM is CC BY-NC-ND |
| Running the benchmark on other hardware | NVIDIA: a self-cleaning script (`infra/bench/run-gpu-benchmark.sh`) rather than a CDK stack, since a benchmark is a one-off job: it creates a bucket, a scoped IAM role and one instance with no inbound access and a hard time limit, and deletes them all on exit. Apple Silicon: documented manual steps, because EC2 Mac hosts have a 24-hour minimum that a script can't clean up early |
| How multi-mic WER is scored | Both with crosstalk (everything transcribed on each mic) and without (only words inside the speaker's own reference speech). The second compares models fairly and is the target for Phase 2 |

## Open questions

- **Default model:** on CPU, `small` matches `turbo`'s accuracy at 2.9× the speed in Phase 0. Should the default depend on the device (`small` on CPU, `turbo` on NVIDIA)? Check `small` on non-English audio first; the Phase 0 set is English only. `distil-large-v3.5` is most accurate with crosstalk excluded but transcribes the most bleed and is English only: revisit after Phase 2.
- **Live transcript in the studio:** useful to see, or distracting while recording? Could be a toggle.

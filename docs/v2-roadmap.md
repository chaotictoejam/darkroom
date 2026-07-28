# Darkroom v2 Roadmap

Darkroom today (v1) is a local-first editor: you bring pre-aligned camera/audio files, it transcribes them with faster-whisper, an AI pass proposes an edit decision list (EDL), you review and tweak in the browser, then FFmpeg renders the result.

v2 turns Darkroom into a full local-first alternative to Descript/Riverside — it also **records** your footage, edits more like a real NLE, lets you choose local or cloud transcription, exports up to **4K**, and adds an **AI Tools** panel where every AI-powered action shows you a real dollar estimate for your specific project before you click it.

This document is the user/contributor-facing summary of that plan. Everything here is additive to v1 — nothing described below removes or breaks the current upload → transcribe → analyze → render workflow.

---

## Key decisions

- **Recording is a desktop app, editing stays a web app.** A new Electron shell hosts the existing React frontend and adds native screen/window/webcam/mic capture as separate tracks. If you just want to upload files and edit, nothing changes — you keep using the browser at `localhost:5173`/`:8000` exactly as today.
- **No wholesale rewrite.** Python/FastAPI keeps doing what it's already good at: transcription (faster-whisper), AI orchestration (Anthropic/Bedrock), and FFmpeg rendering. TypeScript is introduced only where Python is the wrong tool — the Electron capture layer.
- **Cloud transcription option: Amazon Transcribe.** An alternative to local faster-whisper for anyone who'd rather not run a model locally or wants to transcribe on a machine without much CPU/GPU. Its output is mapped into the exact same transcript format Darkroom already uses, so nothing downstream (the editor, EDL generation, subtitles) needs to know or care which engine produced it.
- **Every AI Tools button shows its real cost before you click it**, computed from your project's actual transcript length and duration — not a generic number from a pricing page.
- **No Docker required for AWS deployment.** The CDK stack stays deployable with just `cdk deploy` — no local Docker daemon needed for Lambda bundling.

---

## What's new

### 1. Recording

A desktop app (built on Electron) that can capture your webcam, one or more monitors/application windows, and your microphone — each as its own separate track, the same way Darkroom already treats multi-camera uploads. Start a recording, pick your sources, stop, and the files land directly in a new project ready to transcribe and edit. If you open Darkroom in a plain browser tab instead of the desktop app, recording still works via your browser's own screen-share picker — you just won't get simultaneous multi-monitor capture without the desktop app.

### 2. Richer editing

- Manually override which camera/layout is shown per segment (today this is AI-only).
- Compose a screen-share track with a webcam picture-in-picture, or drop a static image/logo overlay into your edit.
- An asset library for logos, title cards, and other images you reuse across projects.

### 3. Choice of transcription engine — and better local accuracy

Pick **local (faster-whisper)** or **cloud (Amazon Transcribe)** per project, same as today's per-project Whisper model/language choice. Cloud is available once you've configured AWS credentials; local stays the zero-cost, zero-setup default.

Cloud isn't the only lever for accuracy, though — the local path improved directly: Silero VAD filtering runs by default (strips silence/breathing before the model ever sees it, which cuts hallucinations more than any post-hoc cleanup), `large-v3` is available as the best-accuracy model choice, and there's an optional forced-alignment pass (wav2vec2, opt-in per project) that tightens word-level timing beyond what Whisper's own timestamps give you — the part that actually matters for word-level cuts and karaoke subtitles. Diarization is intentionally absent throughout: every track is already speaker-tagged by camera/mic at upload, which is more accurate than guessing speaker identity from a mixed signal.

### 4. Higher-resolution exports

Render at 1080p (today's default) or 4K. If your source footage doesn't actually have 4K detail, Darkroom will tell you instead of silently upscaling and calling it 4K.

### 5. A real audio engine

Loudness normalization already happens today; v2 gives audio processing its own dedicated engine so it can grow into noise reduction, true filler-word removal (not just marking words for cutting, but seamlessly closing the gap), and per-word volume leveling — without tangling that logic into the video compositing code.

### 6. AI Tools panel

A Descript-style panel of one-click AI actions, grouped the same way: **Sound good**, **Look good**, **Repurpose**, **Publish**. Every button shows you what it'll cost to run on *your* project before you commit to it.

---

## AI Tools catalog

This is the full assessment of every tool in the target panel — how feasible it is, how it'd actually be built, and what it costs. Nothing here is committed to be built immediately except where noted in the [rollout plan](#rollout-plan) below; this table is the roadmap for the whole panel.

| Tool | Feasibility | How it'd work | What it costs |
|---|---|---|---|
| **Sound** | | | |
| Edit for clarity | High | AI rewrite pass over your transcript | Small AI text call |
| Studio Sound | High | Local audio cleanup (denoise, EQ, compression) — no cloud call | Free, runs locally |
| Remove filler words | High | Already detected today; upgrading to seamless removal (not just marking) is audio-engine work | Free (reuses existing analysis) |
| Generate audio | Medium | Text-to-speech via AWS Polly | Charged per character generated |
| Remove retakes | Medium | Detect near-duplicate lines in the transcript and keep the best one | Small AI call, cheap |
| Shorten word gaps | High | Pure audio timing — no AI needed | Free, runs locally |
| Add chapters | High | AI proposes titled chapter markers from your transcript | Small AI text call |
| **Looks (Video)** | | | |
| Quick design | High | Template-based title cards/lower-thirds, optional AI-written copy | Free to near-free |
| Eye Contact | Low | Needs a gaze-correction model with no managed cloud equivalent — research-stage, not near-term | Local compute, but real R&D needed first |
| Center active speaker | Medium | Extends existing face-detection into continuous speaker tracking | Free, local (more CPU) |
| Green screen | High | Background removal via segmentation or literal chroma key | Free, runs locally |
| Skin smoothing | High | Local per-frame smoothing filter | Free, runs locally |
| Automatic multicam | High | Mostly already built — v1 already auto-assigns cameras from who's speaking | Free (reuses existing analysis) |
| Generate visuals | Medium | AI image generation (Bedrock image models) | Charged per image |
| Blur speaker background | High | Same technique as green screen, blurs instead of replaces | Free, runs locally |
| **Socials/Repurpose** | | | |
| Create clips | ✅ Already built | Existing Shorts/clips feature | Free |
| Create highlight reel | High | AI selects and stitches several best moments into one video | Small AI text call |
| Find highlights | ✅ Already built | Same underlying feature as clips | Free |
| Translate | High | Amazon Translate for the transcript, optional dubbed audio via Polly | Cheap per-character; dubbing costs more |
| **Publishing Help** | | | |
| Draft YouTube description | High | AI call over transcript | Tiny AI text call |
| Generate YouTube thumbnail | Medium | AI image generation | Charged per image |
| Draft show notes | High | AI call over transcript | Tiny AI text call |
| Draft a title | High | AI call, can be bundled with the description | Tiny AI text call |
| Summarize | High | AI call over transcript | Tiny AI text call |
| Draft a social post | High | AI call over transcript | Tiny AI text call |
| Draft a blog post | High | AI call, longer output than the others | Small AI text call |

---

## Rollout plan

1. **Foundations** ✅ — 4K/1080p export option, Amazon Transcribe as an alternative transcription engine, audio engine groundwork. Also converted the CDK deployment stack to TypeScript.
2. **Recording** — the Electron desktop app and multi-track capture.
3. **Richer editing** — asset library, screen-share/image overlays, manual per-segment layout control.
4. **AI Tools panel** — the cost-estimate UI, plus the tools that are already high-feasibility and low/no-cost: real filler-word removal, chapters, highlight reels, translation, and the Publish-section drafting tools (description, title, show notes, summary, social post, blog post).
5. **Research tier** — Eye Contact correction, refined speaker-centering, AI-generated visuals/thumbnails, skin smoothing, green screen, and background blur. Each gets its own design pass when its turn comes.

---

*This roadmap reflects planning as of 2026-07-28. It will be updated as phases land.*

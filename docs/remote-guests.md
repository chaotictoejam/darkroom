# Remote Guests: Plan

Status: **planned**, not started. Tracked in [ROADMAP.md](../ROADMAP.md).

Let a host record a podcast with guests who are somewhere else, while keeping Darkroom's core promise as close as possible: studio-quality local tracks, no central Darkroom service, and nothing kept in the cloud after the session.

---

## Goals

- A guest joins from a link in a normal browser. No install, no account.
- Each participant's track is recorded **locally on their own machine** at full quality, so a bad connection only affects the live conversation, never the recording.
- Guest tracks arrive in the host's project already aligned, ready to transcribe like any other track.
- The cloud side **exists only for the session**: created when the host starts one, torn down when it ends, and hard-expired if the host disappears.
- Infrastructure is deployed by the user into **their own cloud account** (like the existing `infra/` CDK stack). There is no shared Darkroom server.

## Non-goals (for the first version)

- Video guests. Audio only, matching in-app recording today.
- Live streaming or broadcasting.
- More than 4 participants total (host + 3 guests), the current track limit.

---

## How it works

This is a "double-ender": the live call and the recording are separate.

```
 Host (Darkroom desktop)                       Guest (browser, from invite link)
 ───────────────────────                       ─────────────────────────────────
 records own mic locally (full quality)        records own mic locally (full quality)
 records the guest's *call* audio as a         uploads encrypted chunks every few seconds
   low-quality reference track                          │
          ▲        ▲                                     ▼
          │        └──── WebRTC live call (P2P, ───► per-session storage
          │              TURN relay if needed)              │
          └─────────── downloads + decrypts ◄───────────────┘
                       aligns to reference → adds track to project
```

1. **Host creates a session** from the Record tab. The desktop app calls the user's deployed session API, which creates the session's resources and returns an invite link.
2. **Guest opens the link**, grants mic access, and lands in a lobby with a mic check. Host sees the guest's name and level meter.
3. **Live call** runs over WebRTC (Opus, low latency). Signaling goes through the session's signaling endpoint; media goes peer to peer, falling back to a TURN relay when NAT blocks a direct path.
4. **Host presses Record.** A start message goes to every participant over the WebRTC data channel and everyone starts their local recorder (the existing `Recorder` component).
5. **Guest uploads while recording.** Chunks are encrypted in the browser and uploaded every few seconds, so a closed tab or crash loses seconds, not the episode.
6. **Host presses Stop.** Guests finish uploading (their page shows progress and asks them not to close it).
7. **Host imports.** The desktop app downloads and decrypts the chunks, assembles each guest track, aligns it (see below) and adds it to the project as a normal participant track.
8. **Session ends.** The host ends it, or it hits its expiry time; either way every session resource is deleted.

### Alignment

Local recordings start on different machines with different clocks, so they need aligning:

- **Coarse:** clock sync over the data channel (NTP-style ping exchange) before recording gives each guest's offset to within tens of milliseconds.
- **Fine:** the host also records the guest's *call* audio, which is already on the host's timeline. Cross-correlating the guest's high-quality local track against that reference gives a sample-accurate offset.
- **Drift:** sound card clocks differ by a few parts per million, which adds up over an hour. Measure the offset in several windows across the recording; if it drifts beyond a threshold, resample the guest track with FFmpeg to match.
- **Fallback:** if correlation fails (e.g. long silences), use the clock-sync offset and flag the track in the UI so the host can nudge it.

### Privacy and security

- **Encrypted uploads:** the invite link carries an encryption key in the URL fragment (`#...`), which browsers never send to servers. Guest chunks are encrypted with AES-GCM before upload, so the storage bucket only ever holds ciphertext.
- **Encrypted call:** WebRTC media is DTLS-SRTP encrypted end to end; a TURN relay forwards packets it cannot decrypt.
- **Unguessable links:** session and invite tokens are at least 128 bits of randomness. The host gets a separate host token; guests can't end the session or read each other's uploads.
- **Nothing kept:** uploads are deleted after a successful import, and storage has a lifecycle rule as a backstop. Session records expire automatically.
- **Honest wording:** the README should say plainly that remote sessions send encrypted audio through the user's own cloud account, unlike local-only recording.

---

## Hosting the session: two options

Both meet "only exists for the session". The difference is whether the per-session part is *data in always-available serverless services*, or *a whole machine*.

### Option A: Serverless (recommended)

Deployed once into the user's AWS account via CDK, next to the existing `infra/` stack. Costs nothing while idle; each session is just records and objects that expire.

| Piece | Service |
|---|---|
| Session API (create, join, end, upload URLs) | API Gateway HTTP API + Lambda |
| Signaling | API Gateway WebSocket API + Lambda |
| Session and connection state | DynamoDB with TTL (hard expiry, e.g. 12 hours) |
| Guest uploads | S3, per-session prefix, presigned URLs, lifecycle expiry + abort incomplete uploads |
| Guest web page | Static files on S3 + CloudFront |
| TURN relay | Managed: Cloudflare Realtime TURN, Twilio, or Kinesis Video Streams WebRTC (decide in spike) |

Kinesis Video Streams is worth a close look: it provides signaling *and* TURN through a signaling channel that can be created per session and deleted afterwards, which would remove the custom WebSocket layer.

### Option B: Ephemeral instance per session

A small Lambda launches one container per session (ECS Fargate, or a Fly.io Machine) running signaling, coturn and an upload receiver. The container shuts itself down when the session ends or goes idle.

### Comparison

| | A: Serverless | B: Ephemeral instance |
|---|---|---|
| Cost when idle | ~$0 | $0 (nothing running) |
| Cost per session | Fractions of a cent plus TURN traffic | Instance-minutes (cents per hour) plus traffic |
| Time to start a session | Instant | 30–90 s container cold start |
| TURN | Managed provider | Self-run coturn, needs public UDP ports |
| Code to maintain | Several Lambdas + infra | One container, simpler locally |
| Easy to self-host off AWS | No | Yes (any container host) |

**Recommendation:** Option A. Instant session start matters when a guest is waiting, managed TURN avoids running UDP infrastructure, and it extends the CDK stack the project already has. Keep the session API small and provider-agnostic so Option B can be added later for people who don't use AWS.

---

## TODO

### Phase 0: Spike and decisions
- [ ] Prototype a two-browser WebRTC call with signaling, to measure connection success with and without TURN
- [ ] Choose TURN provider (Cloudflare vs Twilio vs Kinesis Video Streams) on cost, setup effort and reliability
- [ ] Decide whether to use Kinesis Video Streams for signaling too, or a custom WebSocket API
- [ ] Prototype alignment: cross-correlate a local track against a recorded call track and measure accuracy and drift over 60 minutes
- [ ] Confirm the final choice between Option A and Option B

### Phase 1: Session infrastructure (`infra/`)
- [ ] CDK stack: HTTP API, WebSocket API, Lambdas, DynamoDB table with TTL, S3 bucket with lifecycle rules, CloudFront for the guest page
- [ ] Session API: `create`, `join`, `end`, `upload-url`, `list-uploads`, with host and guest tokens
- [ ] TURN credential endpoint (short-lived credentials per participant)
- [ ] Hard expiry and teardown: everything for a session is deleted on `end` or after the TTL, even if the host never returns
- [ ] Stack outputs the session API URL; desktop app reads it from `.env` (e.g. `DARKROOM_SESSION_API`)

### Phase 2: Live call
- [ ] Shared WebRTC module: peer connections, data channel, reconnects
- [ ] Guest web page: join from link, name entry, mic check, lobby, call UI
- [ ] Host UI in the Record tab: create session, copy invite link, see guests and their levels, remove a guest
- [ ] Clock-sync handshake over the data channel

### Phase 3: Remote recording
- [ ] Start/stop broadcast over the data channel; all participants start their local `Recorder`
- [ ] Host also records each guest's incoming call audio as a reference track
- [ ] Guest-side AES-GCM encryption with the key from the URL fragment
- [ ] Chunked upload during recording, with retries and an upload progress screen after Stop
- [ ] Resume uploads if the guest reloads the page mid-session

### Phase 4: Import and alignment
- [ ] Desktop app downloads, decrypts and assembles guest chunks
- [ ] Backend alignment step: coarse offset, cross-correlation, drift correction with FFmpeg
- [ ] Add aligned guest tracks to the project alongside the host's tracks, then transcribe as usual
- [ ] UI flag and manual nudge for tracks where alignment confidence is low
- [ ] Delete uploads once import succeeds

### Phase 5: Hardening and docs
- [ ] Failure handling: guest drops mid-recording, host app crashes, upload never completes
- [ ] Security review of tokens, presigned URL scope, CORS and expiry
- [ ] Cost estimate from real sessions, added to the README Costs section
- [ ] README: deploying the session stack, starting a session, privacy wording

---

## Open questions

- Should a guest who loses connection mid-recording keep recording locally and upload when back online? (Likely yes; local recording doesn't need the call.)
- How long should a session be allowed to live? 12 hours is a placeholder.
- Should guest tracks stay in FLAC like local recordings, or be uploaded as Opus to save bandwidth and transcoded on import?
- Is there demand for a non-AWS deployment early enough to build Option B first?

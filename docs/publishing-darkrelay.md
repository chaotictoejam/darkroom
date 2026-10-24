# Publishing to DarkRelay: Plan

[DarkRelay](https://github.com/chaotictoejam/darkrelay) is the publishing half of Darkroom: self-hosted podcast hosting, RSS feeds and analytics in the user's own AWS account. Darkroom records, edits and exports; DarkRelay publishes and measures. This plan covers getting an edited episode from Darkroom into DarkRelay.

## Goals

- **One export, everything DarkRelay needs:** audio, transcripts, chapters, cover art, video and episode details in DarkRelay's episode bundle format, so publishing is `darkrelay publish <dir> --show <slug>` with no flags.
- **Timed to the edit.** Transcripts and chapters line up with the exported audio, not the raw recording: EDL cuts and word cuts shift them, and muted words are left out.
- **Re-export updates the same episode.** Fixing a typo or a cut and exporting again replaces the episode in DarkRelay rather than creating a second one.
- **Local by default.** The export writes files on this computer. Uploading is the user's step, into their own AWS account.

## Non-goals (for this plan)

- Managing shows (creating them, show artwork, going live). That stays in the DarkRelay CLI and dashboard.
- Analytics in Darkroom.
- Generating titles, show notes or chapters with AI (see Open questions).

## The bundle

DarkRelay's format is defined in `packages/core/src/bundle.ts` in the darkrelay repo. Darkroom writes it to `projects/<id>/output/darkrelay/`, and a zip of the same folder to `output/darkrelay.zip` for browser users.

| File | From |
| --- | --- |
| `episode.json` | The episode details form (below), plus `durationSeconds` from the exported MP3 and `transcriptLanguage` from the transcription language |
| `audio.mp3` | The MP3 export (the same render as **Export MP3**, loudness-normalised) |
| `transcript.vtt` | Edited-time captions with `<v Speaker>` voice tags. DarkRelay sends this one to YouTube as captions |
| `transcript.srt` | The same cues, `Speaker: text` |
| `transcript.json` | Podcasting 2.0 JSON transcript with a speaker per segment |
| `chapters.json` | Podcasting 2.0 JSON chapters, when the episode has any |
| `cover.jpg` / `cover.png` | Episode artwork, when uploaded (otherwise the show's is used) |
| `video.mp4` | Video projects only, unless turned off: the full edit, for a video show or YouTube |

### Edited time

The exported audio is the kept EDL segments with word cuts removed (`_apply_word_cuts` in `renderer.py`, the same pieces every full-length render uses). A source time maps into the export by adding up the kept pieces before it.

- A word is kept if its midpoint is inside a kept piece and outside every word mute. A word straddling a cut keeps the part that is heard.
- Cues group words by speaker and break on a speaker change, a pause over 1 s, 6 s of speech, or 84 characters. Every cue lasts at least 0.1 s and ends inside the audio.
- Chapters are stored in **source time**, so they follow later edits. A chapter inside a cut moves to where the edit resumes, one after the end of the edit is dropped, and two that land on the same moment keep the later title. The form shows and accepts edited time, converting with `timeMap.ts`.

### Episode details

Stored in the project as `publish` (in `new_project()` and backfilled key by key in `get_project()`):

`show` (DarkRelay slug), `title`, `notes` (HTML, or plain text that becomes paragraphs), `pub_date` (ISO with offset, or none for "when published"), `episode_type`, `season`, `episode`, `explicit` (none = the show's default), `keywords`, `chapters`, `include_video`, `yt_title`, `yt_description`, plus `guid`, `cover` and the last `bundle`, which the backend sets.

The backend checks DarkRelay's rules before exporting (slug format, required title and notes, YouTube's 100-character title, 5000-byte description and no `<` or `>`), so a bundle doesn't fail only once it reaches AWS. Warnings that don't block the export (cover art not square or outside 1400 to 3000 px, first chapter not at 0:00) are shown with the bundle.

### API and UI

- `PUT /api/projects/:id/publish` saves the details; `POST`/`DELETE /api/projects/:id/publish/cover` sets cover art.
- `POST /api/projects/:id/publish/bundle` runs the export as a job (shares the render lock; progress over the WebSocket).
- Editor sidebar **Publish to DarkRelay**: **Details…** opens the form; **Export bundle** writes the bundle; the result lists the files and warnings, links the zip, and shows the `darkrelay publish` command for the folder with a copy button.

## TODO

### Phase 1: Bundle export

- [x] `publish` project field with backfill
- [x] Edited-time transcript (VTT, SRT, Podcasting 2.0 JSON) and chapters, word cuts and mutes applied
- [x] `episode.json` with DarkRelay's validation rules checked first; GUID set once
- [x] Cover art upload; video for video projects
- [x] Export job, bundle folder and zip
- [x] Sidebar panel and details form; chapters in edited time, at the playhead or one per take
- [x] Tests: time mapping, cues, chapters, notes, validation, the export job end to end
- [x] Checked against DarkRelay's own `planBundle`: no ignored files, `episode.json` and `chapters.json` validate
- [x] Bundle criteria tests (`backend/tests/test_bundle_criteria.py`): a checker mirroring DarkRelay's rules (`tests/bundle_criteria.py`) is shown to catch each kind of broken bundle, then real exports (podcast, video, awkward transcripts, chapters in cuts, nothing left to transcribe) must pass it. With `DARKRELAY_DIR` set, bundles also go through DarkRelay's own code (`tests/darkrelay_check.mts`)

### Phase 2: Publish from Darkroom

- [ ] Optional **Publish** button that runs the DarkRelay upload itself (S3 `inbox/<show>/<bundleId>/`, `episode.json` last), using the user's AWS profile and the DarkRelay stack's bucket. Says plainly that the episode is uploaded to their AWS account
- [ ] Follow the publisher's result (`inbox-status/`) and show published, scheduled or rejected with the reasons
- [ ] Show picker from the deployment's `catalog/` instead of typing the slug
- [ ] Desktop: **Show in folder** for the bundle through `window.darkroom`

### Phase 3: Richer episodes

- [ ] Audiogram as `video.mp4` for audio-only shows, once [audiograms](audiograms.md) land
- [ ] `persons` (podcast:person) from speakers, with host/guest roles
- [ ] Chapter markers on the editor timeline

## Decisions

| Question | Decision |
| --- | --- |
| Upload from Darkroom, or export a folder? | **Export a folder first.** It needs no AWS credentials in Darkroom, keeps the export fully local, and the DarkRelay CLI already handles uploads, retries and the publish result. Direct publishing is Phase 2 and opt-in |
| Who sets the episode GUID? | **Darkroom, once, on the first export**, stored in `publish.guid`. Every later export of the project carries it, so DarkRelay updates the same episode. The CLI would otherwise make a new one for each fresh folder |
| Chapter times: source or edited? | **Stored in source time, shown in edited time.** Chapters then follow later edits instead of drifting |
| Muted words in the transcript? | **Left out.** They are silent in the audio, and mutes are usually for words that shouldn't be published |
| Which transcript formats? | **All three.** VTT for YouTube captions and Apple, SRT for apps that prefer it, JSON for speaker names in Podcasting 2.0 apps. Each becomes a `<podcast:transcript>` |
| How are bundles tested? | **Against written-down criteria, not just "the export ran".** `tests/bundle_criteria.py` mirrors DarkRelay's schema (file roles, `episode.json`, YouTube limits, chapters) and what apps need from the files (real MP3/MP4/PNG/JPEG, well-formed VTT/SRT/JSON, every cue and chapter inside the audio, the formats agreeing). The cross-check with DarkRelay's own code runs when `DARKRELAY_DIR` points at a checkout, since Darkroom's tests don't need Node. When DarkRelay's rules change, update the checker |
| Release times | **Rewritten as `YYYY-MM-DDTHH:MM:SS±HH:MM`.** Python accepts ISO forms (a space instead of `T`, `20261101T1000Z`) that DarkRelay's schema rejects |
| Cover art type | **Decided by the file's content, not the browser's label**, so `cover.png` is always a PNG |
| Audio format | **The MP3 export (192 kbps).** DarkRelay rejects WAV and FLAC for feeds |

## Open questions

- Should AI suggest a title, show notes and chapters from the transcript? It would be the second thing that sends transcript text off the machine, so it needs the same provider choice and confirmation as Analyse (and a local model, per [Private AI](private-ai.md)).
- Should Darkroom remember a default show (and explicit flag) across projects, not just per project?

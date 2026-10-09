# Timeline Editing: Plan

Status: **planned**, not started. Tracked in [ROADMAP.md](../ROADMAP.md).

Make the editor's timeline a place to edit, not just to look. Today most editing happens in the transcript. The timeline can only drag-select a range and delete it, and it shows the **source** recording with cuts drawn over it. Descript's timeline shows the **edited** episode as blocks of words and gaps: you drag a gap's edge to shorten the silence, split at the playhead, and select and delete pieces right on the timeline. This plan brings that to Darkroom.

---

## Goals

- **Show the edit, not the source.** The timeline runs in output time: cut material disappears, and a small marker at each cut shows where it was and can restore it.
- **Script lane:** the transcript laid out as phrase blocks and **gap blocks** labelled with their length (`0.9s`), like Descript.
- **Drag silence:** drag a gap block's edge to shorten the pause. Later, drag it wider to lengthen it.
- **Split and delete:** split at the playhead (`S`), click a piece to select it, `Delete` to cut it. Drag-select a range and delete it, snapped to word boundaries.
- **Shorten gaps in bulk:** "Shorten pauses longer than X to Y" in one action.
- **One selection, one undo history** shared by the transcript and the timeline: select words in one, see them selected in the other; `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` undo and redo either.
- **Lanes per track:** one waveform lane per speaker, and later the sound tracks from [recording-studio.md](recording-studio.md) Phase 6 and B-roll from "Unsynced media on the timeline".
- **Properties panel for the selection:** volume for a range or a whole speaker track, Studio sound controls, and the loudness target, like Descript's Properties panel.
- Everything stays local; no new data leaves the machine.

## Non-goals (for this plan)

- Moving or reordering clips (Phase 5 sketches it, but it needs its own design; see Open questions).
- Per-track cuts (cutting one speaker while the others keep playing). All tracks are synced and cut together, as now; per-speaker **volume** changes (including turning a speaker down to silence) are in scope.
- Building Studio sound itself; that's [recording-studio.md](recording-studio.md) Phase 7. This plan only gives it a place in the editor.
- Multi-camera angle editing on the timeline; the EDL still picks camera and layout.
- Keyframed effects, transitions, or a general-purpose NLE.

---

## What exists today

`Timeline` in `frontend/src/views/Editor.tsx`:

- One 100 px lane in **source time**, with the **first speaker's** waveform only (`GET /api/projects/:id/waveform`).
- EDL segments shaded green (kept) or red (cut), manual `word_cuts` drawn as red bars, pause markers (`~` / `~~~`) for gaps ≥ 0.4 s.
- Zoom (wheel, ±, up to 100×), pan via a scrollbar, auto-scroll to follow the playhead.
- Drag to select a free range (not snapped to words), adjust its edges, `Delete` adds it to `word_cuts`. A click seeks.

Related pieces this plan builds on:

- `buildKeptRanges`, `sourceToOutputTime` and `outputToSourceTime` in `Editor.tsx` already convert between source and edited time for the preview proxy.
- The transcript already shows pause chips (≥ 0.5 s, `MIN_PAUSE`) and gap chips where cuts were made, toggles silence-only EDL segments as a whole, and has "undo last cut" (`Ctrl+Z`, cuts only).
- `word_cuts` and `word_mutes` already apply in the preview, full edit, vertical and MP3/WAV renders. So shortening gaps and deleting split pieces need **no renderer changes**; only lengthening a gap does.

---

## Design

### Edited time and cut markers

The ruler and every lane are drawn in **output time**, using the kept ranges the editor already computes. Where material was cut, the lanes butt together and a thin **cut marker** sits at the join. Hovering it shows what was removed (duration, the cut words, the EDL reason if the EDL cut it); clicking it restores the cut, just as gap chips do in the transcript.

A **Show cuts** toggle switches back to source time with cuts drawn as overlays (the current view), which helps when checking what the AI removed.

Internally all edits are still stored in **source time** (`word_cuts`, EDL segments, `word_mutes`). The timeline converts pointer positions to source time before changing anything, so the data model and renderer stay as they are.

### Lanes

```
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ 21:14     21:16     21:18 │   21:20     21:22     21:24     21:26          │ ruler (output time)
 │ [It's why I don't list…] [⋯] [And that's exactly] [0.9s] [Not by breaking] │ script lane
 │ ▁▂▅▃▂▁▁▂▆▇▅▂▁            │ ▁▂▃▅▂▁       ▁▁▂▆▅▃▂▁▁                           │ A · Alice
 │        ▁▁▂▃▂▁ ▁▂▅▆▃▁▁    │      ▁▂▃▂▁                     ▁▂▄▃▁            │ B · Bob
 │ [Late Afternoon Loop.wav ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~] │ Music (Phase 6)
 └───────────────────────────────────────────────────────────────────────────┘
                           ▲ cut marker              ▲ playhead
```

- **Script lane:** consecutive words from one speaker form a **phrase block** (split at gaps ≥ 0.4 s and at speaker changes). Text is truncated to fit; zooming in shows more words, and at high zoom each word is its own block. Gaps become **gap blocks** labelled with their duration; gaps shorter than the label width collapse to `⋯`. Blocks are tinted per speaker.
- **Speaker lanes:** one waveform per speaker track (`cam_<id>`), so you can see who is talking and spot crosstalk. The waveform endpoint is already per file; the timeline fetches one per speaker.
- **Sound lanes** (recording-studio Phase 6) and **B-roll lanes** (unsynced media) slot in below as they land. This plan only reserves the space and the lane component.
- Lane heights are compact by default; the timeline gets a draggable divider so it can grow at the expense of the transcript.
- Only blocks in the visible window are rendered (the current `inView` filtering), so hour-long episodes with tens of thousands of words stay fast.

### Selecting and deleting

- **Click** a block to select it (a phrase, a word at high zoom, a gap, or a split piece). **Shift-click** extends the selection. **Drag** on the script lane selects a range **snapped to word boundaries**; hold `Alt` to select freely (for coughs and breaths inside a word gap). Dragging on a waveform lane selects freely, as now.
- The selection is **shared with the transcript**: selecting on the timeline highlights the words in the transcript and scrolls to them, and vice versa.
- **Delete / Backspace** cuts the selection (adds it to `word_cuts`, merged and sorted as now). **M** mutes it (`word_mutes`). Cutting EDL-cut material is a no-op; restoring is done from the cut marker.

### Split

- **S** splits the block under the playhead; **Shift+S** splits at both ends of the selection. A split is just a stored boundary (source time, snapped to the nearest word gap unless `Alt` is held), drawn as a line through all lanes.
- Splits divide phrase blocks into pieces you can click and delete as a unit. They also mark where clips would separate if reordering lands (Phase 5).
- Splits are saved with the project (`timeline_splits`) so they survive reloads.

### Gap blocks: drag silence

- Drag either edge of a gap block **inward** to shorten the pause. The label shows the new length while dragging (`0.9s → 0.4s`), and the playhead previews the join on release.
- The removed part is stored as a normal `word_cut` **centred in the gap**, so the tail of the word before and the onset of the word after are never clipped, whichever edge you drag. A minimum of 0.1 s of the original silence always stays (configurable later).
- Dragging the same gap again **replaces** that gap's cut (any manual cut lying entirely inside the gap) instead of stacking cuts.
- **Double-click** a gap to cut it down to the default pause length (0.3 s).
- **Shorten pauses…** (timeline menu): every gap longer than *X* is cut down to *Y* (defaults 1.0 s → 0.5 s), as one undoable step. It skips gaps the EDL already cut.

### Properties panel: volume, Studio sound and loudness (Phase 3)

Like Descript's **Properties** panel, selecting something on the timeline or in the transcript opens a properties section in the right-hand side panel. What it shows depends on the selection:

| Selection | Duration | Volume | Studio sound |
|---|---|---|---|
| A range or split piece | Length in edited time (read-only) | **Range gain** | Shows the track's setting (read-only) |
| A speaker lane (click its header) | n/a | **Track gain** | **Per-track on/off and strength** |
| Nothing (project) | Episode length | n/a | **Project on/off, strength, engine** |
| A sound cue (Phase 6) | Cue length | Cue gain | n/a (sounds are never enhanced) |

Volume, Studio sound and loudness are three separate stages, and the plan for each lives in one place:

```
 speaker track ─▶ Studio sound ─▶ track gain ─▶ range gain ─▶ mutes ─┐
 (cam_<id>)       (recording-studio  (this plan)   (this plan)   (exists)  ├─▶ mix ─▶ sound cues ─▶ loudnorm ─▶ output
                   Phase 7, cached)                                       │        (Phase 6)      (exists, −16 LUFS)
 other speakers ──────────────────────────────────────────────────────────┘
```

- **Studio sound** (noise removal, de-ess, EQ, compression, matching levels between speakers) is planned and built in [recording-studio.md](recording-studio.md) Phase 7: a cached, non-destructive `cam_<id>.enhanced.wav` per track. This plan only adds its controls to the Properties panel (project and per-track switch, strength, A/B) and a small **SS** badge on speaker lanes where it's on. It stays **per track**, not per range: enhancement is a whole-track background job, and turning it on and off mid-sentence would make the voice's tone jump.
- **Track gain** (`gain_db` per speaker, −24 to +12 dB, shown as % like Descript) evens out a speaker who is still too quiet or loud after Studio sound's matching, or when Studio sound is off.
- **Range gain** (`volume_ranges`) turns a selection up or down: a laugh that's too loud, or a quiet aside. It's applied with `volume=…:enable='between(t,…)'` on that speaker's track, the same way `_mute_filter` applies mutes. A range can affect all speakers or one (selected on a speaker lane), which also covers the "remove a cough on mic B" case without cutting. A short fade (20 ms) at each edge avoids clicks.
- **Loudness normalisation** already happens: every export runs `loudnorm` to −16 LUFS, true peak −1.5 dB, after mixing, so gain changes shift the balance between moments and speakers but don't change the episode's overall loudness. This plan only adds a **Loudness target** project setting in the Render panel: Podcast −16 LUFS (default), YouTube −14, or Off. The preview proxy skips `loudnorm` for speed, so it uses a quick fixed gain to land near the target.
- Range gain shows on the timeline as a thin gain line over the waveform lane, with the waveform scaled to match, so a boosted or quieted section is visible.

### Lengthening gaps (Phase 4)

Dragging a gap edge **outward** inserts silence. This needs new data and renderer support:

- `silence_inserts: [{at, duration}]`, with `at` in source time (a word boundary), so it moves with the content like sound cues do.
- Audio fills the inserted time with **room tone** (a loop of the quietest stretch of that speaker's own track), not digital silence, which sounds like a dropout. Video holds the frame (`tpad=stop_mode=clone`) or the active camera's frame.
- The renderer splices inserts into every target that applies `word_cuts` (preview, full edit, vertical, MP3/WAV), and the kept-range mapping in the editor grows an "inserted" range type.

### Undo and redo

An editor-level history of edit snapshots: `word_cuts`, `word_mutes`, EDL `keep` flags, `timeline_splits`, plus `volume_ranges` and `speaker_gain` (Phase 3) and `silence_inserts` (Phase 4). These are small arrays, so storing whole snapshots is simpler than inverse operations. Every edit from the transcript or the timeline pushes one entry; a drag pushes one entry on release, not per pointer move. `Ctrl/Cmd+Z` undoes, `Ctrl/Cmd+Shift+Z` (and `Ctrl+Y`) redoes. History is per session (cleared on reload). This replaces the transcript's "undo last cut".

Saving keeps the current pattern: update local state immediately, debounce the PATCH and the proxy re-render.

### Preview while editing

The proxy is a rendered file, so after an edit it is stale until the debounced re-render finishes. While it renders, playback falls back to the source player and **skips cut ranges client-side** (seek past each cut as the playhead reaches it), so a gap you just shortened can be heard straight away. Mutes are already applied the same way.

### Keyboard

| Key | Action |
|---|---|
| Space | Play / pause (as now) |
| S / Shift+S | Split at playhead / at selection edges |
| Delete, Backspace | Cut selection |
| M | Mute selection |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo / redo |
| Esc | Clear selection |
| ← / → | Previous / next word (Shift: extend selection) |
| + / − or wheel | Zoom (as now) |

Shortcuts are ignored while typing in an input or editing a transcript word.

### Code layout

`Editor.tsx` is ~1,500 lines; the timeline moves to `frontend/src/components/Timeline/`:

- `Timeline.tsx` (container: zoom/pan, ruler, playhead, selection, keyboard)
- `ScriptLane.tsx`, `WaveformLane.tsx`, `CutMarker.tsx`
- `timeMap.ts` (kept ranges, source ↔ output mapping, block building; moved out of `Editor.tsx` and shared with the transcript and preview)
- `useEditHistory.ts` (undo/redo)

### Data model

New project fields (in `new_project()` **and** `_DEFAULTS`, plus `api/types.ts`):

```json
"timeline_splits": [812.35, 1140.0],
"speaker_gain": {"A": 0.0, "B": 2.5},
"volume_ranges": [{"start": 905.1, "end": 907.8, "gain_db": -8.0, "speaker": "B"}],
"loudness_target": -16,
"silence_inserts": [{"at": 1290.42, "duration": 0.6}]
```

`speaker_gain`, `volume_ranges` and `loudness_target` arrive in Phase 3, `silence_inserts` in Phase 4. Shortened gaps reuse `word_cuts`; no new field is needed for them.

---

## TODO

### Phase 1: Timeline in edited time, with lanes

- [ ] Move `Timeline` and the source ↔ output mapping out of `Editor.tsx` into `components/Timeline/` (no behaviour change)
- [ ] Ruler and lanes in output time; cut markers with hover details and click-to-restore; **Show cuts** toggle for source time
- [ ] Script lane: phrase blocks per speaker and gap blocks with duration labels; word-level blocks at high zoom; render only the visible window
- [ ] One waveform lane per speaker
- [ ] Resizable timeline height
- [ ] Shared selection between transcript and timeline

### Phase 2: Split, delete and drag silence

- [ ] Word-snapped range selection (`Alt` for free), click and shift-click block selection
- [ ] Delete cuts and `M` mutes the selection from the timeline
- [ ] `timeline_splits` field (backend defaults + types); `S` / `Shift+S`; split lines; select and delete split pieces
- [ ] Gap blocks: drag edges inward to shorten (centred cut, minimum kept silence, replaces the gap's previous cut); double-click to default length
- [ ] **Shorten pauses…** bulk action
- [ ] Editor-level undo/redo for transcript and timeline edits; remove the transcript's "undo last cut"
- [ ] Client-side skipping of cuts during playback while the proxy re-renders
- [ ] Keyboard shortcuts
- [ ] Unify the pause thresholds (timeline 0.4 s, transcript 0.5 s)

### Phase 3: Properties panel, volume and loudness

- [ ] Properties section in the side panel, driven by the current selection (range, speaker lane, project, sound cue)
- [ ] `speaker_gain` and `volume_ranges` fields (backend defaults + types); track gain and range gain controls; gain line on waveform lanes
- [ ] Renderer: track gain and range gain (with edge fades) in preview, full edit, vertical and MP3/WAV, before the mix and `loudnorm`
- [ ] `loudness_target` project setting (−16 / −14 / off) in the Render panel; renderer uses it in place of the hardcoded `I=-16`
- [ ] Studio sound controls in the Properties panel and SS lane badge, once [recording-studio.md](recording-studio.md) Phase 7 lands
- [ ] Tests: gain ranges shifted correctly through EDL and word cuts, per-speaker vs all-speaker ranges, loudness target applied

### Phase 4: Lengthen gaps

- [ ] `silence_inserts` field; drag gap edges outward
- [ ] Room tone: find the quietest stretch per speaker track (cached), loop it for inserts
- [ ] Renderer: splice inserts into preview, full edit, vertical and MP3/WAV; hold the video frame
- [ ] Editor mapping and proxy understand inserted ranges
- [ ] Tests: insert placement through EDL and word cuts, room tone selection, A/V stays in sync across inserts

### Phase 5 (later, needs its own design): Move clips

- [ ] Decide the composition model (see Open questions)
- [ ] Drag split pieces to reorder; sound cues and captions follow their anchors

---

## Decisions

| Question | Decision |
|---|---|
| Timeline in source or edited time? | **Edited (output) time** by default, like Descript; a **Show cuts** toggle shows source time with cut overlays |
| How are edits stored? | Still in **source time** (`word_cuts`, `word_mutes`, EDL `keep`), so the renderer and transcript need no changes for Phases 1–2 |
| Where does a shortened gap's cut go? | **Centred in the gap**, keeping at least 0.1 s, so word tails and onsets are never clipped whichever edge is dragged |
| Re-dragging a gap? | **Replaces** that gap's manual cut rather than adding another |
| Do cuts affect one track or all? | **All tracks**, as now. Per-track edits are out of scope |
| When does this land relative to other roadmap items? | **Phase 1 early** (roadmap item 2, after Private AI), because take dividers, music/SFX tracks, unsynced clips and the Properties panel all build on its lanes. Phases 2–4 stay later |
| Are splits persisted? | **Yes**, `timeline_splits` on the project, so they survive reloads and can become clip boundaries for Phase 5 |
| Inserted silence: digital silence or room tone? | **Room tone** from the same speaker's track |
| Where do volume, Studio sound and loudness live? | **Volume** (track and range gain) in this plan; **Studio sound** in recording-studio Phase 7, with controls in this plan's Properties panel; **loudness** stays the final `loudnorm` after the mix, with a selectable target |
| Studio sound per range or per track? | **Per track** (and project), so a voice's tone never jumps mid-sentence |
| Undo model? | **Snapshots** of the edit arrays in one editor-level history shared by transcript and timeline, per session |

## Open questions

- **Reordering (Phase 5):** moving clips breaks the assumption that the output is the source in order with pieces removed. Options: an ordered clip list (`[{source_start, source_end}]`) that replaces kept ranges as the single source of truth, or keep cuts and add a separate reorder map. The EDL, word cuts, sound cue anchors and captions all depend on this, and it overlaps with "Unsynced media on the timeline", so it should be designed together with that item.
- **Mutes vs volume ranges:** a mute is a range at −∞ dB. Fold `word_mutes` into `volume_ranges` once Phase 3 lands, or keep both?
- **Studio sound per range:** Descript allows it per clip. Per track seems enough; revisit if users ask.
- **EDL segment boundaries:** show them as splits, or keep them as a separate shading?
- **Minimum kept silence and default pause length:** fixed values, or project settings alongside **Shorten pauses…**?
- **Room tone for recordings without a quiet stretch** (constant background music, always-on crosstalk): fall back to digital silence with a short crossfade?

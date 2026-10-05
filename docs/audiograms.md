# Audiograms: Plan

Status: **planned**, not started. Tracked in [ROADMAP.md](../ROADMAP.md).

Turn a podcast episode (or a clip of it) into a video for YouTube and social: cover art or a background, animated audio bars, text, and optionally captions, laid out visually in Darkroom instead of by editing FFmpeg arguments. It grows out of the Chaotic Commits `scripts/audiogram.sh`, which proves the rendering approach but hardcodes colour, size and position.

---

## Goals

- **Make an audiogram from any project**: audio-only podcasts above all, and video projects too when an audio-only version is wanted.
- **Visual layout editor**: drag and resize every element on a preview of the frame; change colours, fonts, sizes, opacity and style without touching code.
- **Templates** saved once and reused for every episode, so a show keeps a consistent look. Per-episode text (title, episode number, custom fields) fills in automatically.
- **Full episode or clips**: a full-length YouTube audiogram, or short clips in square or vertical formats.
- The audiogram uses the **edited audio**: the same mix as the MP3 export (EDL, word cuts and mutes, Studio sound, music and effects).
- Rendering stays **fast and memory-flat** for hour-long episodes, as the script already achieves.
- Everything runs locally, including fonts.

## Non-goals (for this plan)

- A general motion-graphics editor (keyframed animation, transitions between scenes).
- Video backgrounds from stock libraries or any online asset service.
- Publishing straight to YouTube or social platforms.

---

## What the script does today, and what carries over

`chaotic-commits-podcast/scripts/audiogram.sh` renders 1280×720:

| Script behaviour | In Darkroom |
|---|---|
| Full-frame cover art | **Background layer**: image, solid colour or gradient |
| 56 green frequency bars, bottom right, at a fixed x/y | **Bars layer**: position, size, bar count, gap, colour, opacity, style all editable |
| Speech band only (`aresample=3500`) and noise-floor gate (`crop`) so every bar moves | Kept as the default for the bars layer, exposed as **Frequency range** and **Sensitivity** |
| Git-log header (`commit` / `parent` / title) in a translucent box, top right | General **text layer** with variables, e.g. `commit {hash}\nparent {parent_hash}\n{title}`; box colour, opacity and padding editable |
| Shrinks the font so long titles fit | Text layer **fit**: shrink to fit the box width |
| Hash and parent read from `notes.md` files | Per-project **custom fields** (see Variables); the Chaotic Commits header becomes a template |
| Cover decoded once and repeated with `loop`, trimmed to the audio length, `-t` cap; header drawn once before the loop | Same render pipeline (see Rendering) |
| `systemd-run` 2 GB memory cap | Linux-only backstop, not needed if the pipeline stays memory-flat; replaced by a test that checks peak memory on a long file |

---

## The audiogram editor

Opened from the editor's export area as **Audiogram**.

```
┌─ Audiogram ── Template: Chaotic Commits ▾ ─────── [16:9] [1:1] [9:16] ─┐
│ ┌──────────────────────────────────────────────┐  Layers               │
│ │ [cover art]              ┌─────────────────┐ │  ☰ Header text    👁  │
│ │                          │commit 1nv173d   │ │  ☰ Bars           👁  │
│ │                          │parent 11573n3d  │ │  ☰ Captions       👁  │
│ │                          │chore: revoke... │ │  ☰ Background         │
│ │                          └─────────────────┘ │  [+ Add layer]        │
│ │                                              │                       │
│ │              ▮▮▯▮▮▮▯▮▮▮▮▮▯▮▮▮▯▮▮▮▮▮▯▮▮▮▮     │  Bars                 │
│ └──────────────────────────────────────────────┘  Colour [#33FF33]     │
│  ▶ 00:42 ━━━━━━━━━━━━━━━━━━━━━━━━○──────────      Bars 56  Gap 4 px    │
│                                                   Opacity ▬▬▬▬▬▬▬▬▬▯   │
│  Range: (•) Full episode  ( ) Clip 12:03–13:01    Style  Bars ▾        │
│                                                                        │
│  [ Save template ]          [ Render 10 s preview ]   [ Render ]       │
└────────────────────────────────────────────────────────────────────────┘
```

- **Canvas preview**: drawn in the browser at the chosen aspect ratio. Layers are dragged and resized directly, with snapping to edges, centre and a safe-area guide (platform UI overlays on vertical video).
- **Live playback**: the preview plays the edited audio and animates the bars with a Web Audio `AnalyserNode`. It approximates the final look; **Render 10 s preview** produces the exact FFmpeg output for a short stretch.
- **Layers panel**: reorder (draw order), show/hide, select to edit properties.
- **Aspect ratios**: each template keeps a separate layout per ratio (16:9, 1:1, 9:16, 4:5), since a good vertical layout isn't a squashed horizontal one. A new ratio starts from an automatic re-fit of an existing one.

### Layer types

| Layer | Properties |
|---|---|
| **Background** | image (cover art), solid colour, or two-colour gradient; image fit (cover/contain) and blur/darken for readability |
| **Image** | any image (logo, guest photo); position, size, opacity, corner radius |
| **Bars** | style (bars, mirrored bars, line waveform, circular); colour or gradient; bar count, gap, corner rounding; opacity; frequency range; sensitivity; smoothing |
| **Text** | text with variables; font, size, weight, colour; alignment; line spacing; background box (colour, opacity, padding, radius); shrink-to-fit |
| **Captions** | words from the transcript, reusing the existing Shorts subtitle styles (`word`, `chunk`, `box`, `karaoke`, `neon`...), accent colour, position |
| **Progress** | thin bar or elapsed/total time showing playback position |

### Variables

Text layers can use `{title}` (project name), `{episode}`, `{date}`, `{duration}`, `{speakers}`, plus **custom fields** set per project (e.g. `hash`, `parent_hash` for Chaotic Commits). The project's audiogram panel lists the fields its template uses so they're filled in before rendering. A missing field is shown as an error, not rendered as `{hash}`.

### Fonts

Fonts are chosen from fonts installed on the machine (`fc-list` on Linux, the OS font folders elsewhere) plus a few open-licence fonts bundled with Darkroom (e.g. a mono, a sans and a display face), so templates render the same everywhere they're used. Nothing is fetched from Google Fonts or any other service at runtime.

---

## How it works

### Data model

Templates are user-level (reused across projects); each project stores which template it uses plus its own values.

```json
// <data dir>/audiogram_templates/<id>.json
{
  "id": "chaotic-commits",
  "name": "Chaotic Commits",
  "layouts": {
    "16:9": {
      "size": [1280, 720],
      "layers": [
        {"id": "bg", "type": "background", "source": "cover", "fit": "cover"},
        {"id": "bars", "type": "bars", "x": 0.336, "y": 0.828, "w": 0.656, "h": 0.167,
         "style": "bars", "color": "#33FF33", "opacity": 0.9, "count": 56, "gap": 4,
         "freq_max": 1750, "sensitivity": 0.75},
        {"id": "header", "type": "text", "x": 0.981, "y": 0.033, "anchor": "top-right",
         "text": "commit {hash}\nparent {parent_hash}\n{title}",
         "font": "Noto Sans Mono", "weight": "bold", "size": 22, "color": "#33FF33",
         "line_spacing": 8, "box": {"color": "#000000", "opacity": 0.6, "padding": 12},
         "fit": "shrink"}
      ]
    }
  }
}
```

```json
// project.json
"audiogram": {
  "template_id": "chaotic-commits",
  "cover": "audiogram/cover.png",
  "fields": {"hash": "1nv173d", "parent_hash": "11573n3d"},
  "overrides": {}
}
```

- Positions and sizes are **fractions of the frame** with an anchor, so a layout survives a resolution change (720p ↔ 1080p) at the same aspect ratio.
- Per-episode tweaks (e.g. moving the bars clear of something in this episode's cover art) go in `overrides`, keyed by layer id, so the template stays clean.
- Templates can be **exported and imported** as a JSON file (plus their images) to move them between machines.

### Rendering

A new render target, `audiogram`, builds one FFmpeg filter graph from the layout:

1. **Audio** comes from the same path as the MP3/WAV export (`_render_audio`): EDL, word cuts and mutes, Studio sound, music and loudness normalisation. For a clip, only that range of the edited output.
2. **Static layers** (background, images, text) are composited onto one frame **once**, then repeated with the `loop` filter, `fps` and `trim` to the audio length. Never `-loop 1 -i`, which decodes the image as fast as it can and grows memory until the OOM killer steps in (the lesson from the script).
3. **Bars** are generated from the audio (`showfreqs` for bar styles, `showwaves` for the line style, a polar transform for circular), band-limited and gated as in the script, scaled to the layer's box, coloured, keyed transparent and overlaid.
4. **Captions** reuse `generate_ass` with the clip's words mapped through the EDL, burned in with the `subtitles` filter.
5. **Progress** is a `drawbox` whose width is an expression of time.
6. Output: H.264 with `-tune stillimage`, AAC 192 kbps, `-t` capped to the audio duration, `+faststart`.

Text goes to `drawtext` through `textfile=` (titles contain colons and apostrophes), and shrink-to-fit is computed in Python from font metrics instead of the script's 0.6 em estimate. The job runs in a thread and reports progress like other render jobs.

### Clips

Clips use the same `{start, end}` windows on the source timeline as Shorts, so a moment picked for a video Short can also be rendered as an audiogram. Square and vertical layouts are the usual choice for clips; 16:9 for the full episode.

---

## TODO

### Phase 1: Template renderer and layout editor
- [ ] Template and project data model (`audiogram` in `new_project()` + `_DEFAULTS`); user-level template folder; one built-in starter template
- [ ] Renderer: background, image, bars (bar style), text with variables and shrink-to-fit; static layers drawn once and looped; `-t` cap
- [ ] Audio from the export mix path, full episode or a clip range
- [ ] `audiogram` render target and job with progress; output in `output/`
- [ ] Editor: canvas preview, drag/resize layers with snapping, layers panel, property panel (colour, opacity, font, size, position)
- [ ] Live preview playback with `AnalyserNode` bars; **Render 10 s preview** for the exact output
- [ ] 16:9, 1:1 and 9:16 layouts per template
- [ ] Custom fields per project and a missing-field check before render
- [ ] Bundled open-licence fonts and local font listing
- [ ] Recreate the Chaotic Commits look as a template and compare against `audiogram.sh` output
- [ ] Tests: filter graph from a layout, variable substitution, shrink-to-fit, fraction-to-pixel layout, render duration matches audio, peak memory stays flat on a 1-hour file

### Phase 2: Captions, more styles and clips
- [ ] Captions layer using the Shorts subtitle styles
- [ ] Bar styles: mirrored, line waveform, circular; gradients
- [ ] Progress layer
- [ ] Clips: pick ranges in the transcript, share clip windows with Shorts
- [ ] 4:5 layout; automatic re-fit when adding a ratio to a template
- [ ] Per-episode overrides without changing the template
- [ ] Template export/import

### Phase 3: Show-level automation
- [ ] Remember the template per show so new projects start with it
- [ ] Render the full-episode audiogram and selected clips in one go
- [ ] Optional: Claude suggests clip moments as part of Analyse (transcript text only, as today)

---

## Decisions

| Question | Decision |
|---|---|
| Own plan or a phase of the recording studio? | **Own plan.** Audiograms apply to uploaded and recorded podcasts alike and belong to export, not recording |

## Open questions

- **Phase 1 scope:** are captions needed in the first version, or are bars + text + cover enough to replace the script?
- **Template storage location** in the browser (non-desktop) build: alongside `projects/`, or inside each project only?
- **Built-in templates:** ship a few starter looks, or only a blank template plus whatever the user makes?
- **Speaker-aware visuals:** per-speaker bars or highlighting the active speaker's photo, using each mic track separately instead of the mix?

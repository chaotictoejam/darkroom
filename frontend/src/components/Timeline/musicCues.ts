/**
 * Where music and sound cues sit on the timeline, and the edits the music lane
 * and the Music panel make to them.
 *
 * Cues are stored in **source** seconds (like word cuts and chapters) so they
 * move with the content as speech is cut. Intro and outro cues are the
 * exception: they are pinned to the start and end of the *edited* episode, so
 * their blocks are mapped back through the kept ranges to be drawn here.
 */
import type { LibraryTrack, SoundCue, SoundCueKind } from '../../api/types'
import { outputToSourceTime, sourceToOutputTime, type TimeRange } from './timeMap'

/** The shortest cue worth drawing or keeping. */
export const MIN_CUE = 0.05

/** A cue as the lane draws it: a span of source time with a label. */
export type CueBlock = {
  cue: SoundCue
  start: number
  end: number
  name: string
  /** The library track was deleted, so this cue plays nothing. */
  missing: boolean
}

export function outputDuration(keptRanges: TimeRange[]): number {
  return keptRanges.reduce((sum, r) => sum + r.end - r.start, 0)
}

/**
 * The source-time span each cue covers, in timeline order.
 *
 * `duration` is the length of the source recording, used when a bed runs to the
 * end and when there is no edit to map through yet.
 */
export function cueBlocks(
  cues: SoundCue[],
  library: LibraryTrack[],
  keptRanges: TimeRange[],
  duration: number,
): CueBlock[] {
  const byId = new Map(library.map((t) => [t.id, t]))
  const ranges = keptRanges.length > 0 ? keptRanges : [{ start: 0, end: duration }]
  const outDur = outputDuration(ranges)
  const toSource = (t: number) => outputToSourceTime(Math.max(0, Math.min(outDur, t)), ranges)

  const blocks: CueBlock[] = []
  for (const cue of cues) {
    const track = byId.get(cue.library_id)
    const trackLength = cue.length ?? track?.duration ?? 0
    let start: number
    let end: number
    if (cue.kind === 'intro') {
      start = toSource(0)
      end = toSource(Math.min(trackLength, outDur))
    } else if (cue.kind === 'outro') {
      start = toSource(Math.max(0, outDur - trackLength))
      end = toSource(outDur)
    } else if (cue.kind === 'bed') {
      start = cue.at
      const until = cue.until ?? duration
      // A bed that doesn't loop stops when the file runs out, so draw it that
      // way rather than running it to `until` (which is what the mix does --
      // see _place in services/music.py). The file's length is time on the
      // clock of the *edited* episode, so a cut inside the bed stretches the
      // span of source time it covers.
      end =
        cue.loop || trackLength <= 0
          ? until
          : Math.min(until, toSource(sourceToOutputTime(start, ranges) + trackLength))
    } else {
      start = cue.at
      end = cue.at + trackLength
    }
    end = Math.min(Math.max(end, start + MIN_CUE), Math.max(duration, start + MIN_CUE))
    blocks.push({ cue, start, end, name: track?.name ?? 'Missing track', missing: !track })
  }
  return blocks.sort((a, b) => a.start - b.start)
}

/** A new cue of `kind` using `track`, ready to be saved. */
export function newCue(track: LibraryTrack, kind: SoundCueKind, at: number, id: string): SoundCue {
  const bed = kind === 'bed'
  const sfx = kind === 'sfx'
  return {
    id,
    library_id: track.id,
    track: 'music',
    kind,
    at: bed || sfx ? Math.max(0, at) : 0,
    until: null,
    length: null,
    // A bed lives under the voice; an intro, outro or stinger is the voice's
    // equal, so it comes in at full level and doesn't need to get out of the way.
    gain_db: bed ? -14 : 0,
    duck: !sfx,
    duck_db: bed ? -9 : -14,
    loop: bed,
    fade_in: sfx ? 0 : 1,
    fade_out: sfx ? 0 : 2,
  }
}

/** Move a cue to a new source time, keeping a bed's length and staying in range. */
export function moveCue(cue: SoundCue, to: number, duration: number): SoundCue {
  const length = cue.until === null ? null : cue.until - cue.at
  const at = Math.max(0, Math.min(duration - MIN_CUE, to))
  return { ...cue, at, until: length === null ? null : Math.min(duration, at + length) }
}

/** Drag a bed's end to a new source time; never shorter than MIN_CUE. */
export function trimCue(cue: SoundCue, to: number, duration: number): SoundCue {
  if (cue.kind !== 'bed') return cue
  return { ...cue, until: Math.min(duration, Math.max(cue.at + MIN_CUE, to)) }
}

/**
 * The block for a bed or effect being dragged, taken from its own times (the
 * only kinds that can be dragged — an intro and an outro are pinned to the ends).
 */
export function blockFor(base: CueBlock, cue: SoundCue): CueBlock {
  const length = base.end - base.start
  const end = cue.until ?? cue.at + length
  return { ...base, cue, start: cue.at, end: Math.max(cue.at + MIN_CUE, end) }
}

/** Replace one cue in a list by id. */
export function replaceCue(cues: SoundCue[], next: SoundCue): SoundCue[] {
  return cues.map((c) => (c.id === next.id ? next : c))
}

/**
 * How a bed decides where to stop.
 *
 * These are the three states the stored cue can already be in, named: the
 * backend reads `until` and `loop`, and there is no separate field for this.
 * - `episode` -- runs to the last word, repeating as often as it must.
 * - `track`   -- plays once and stops when the file runs out.
 * - `time`    -- stops at `until`, repeating to fill if the file is shorter.
 */
export type BedEnding = 'episode' | 'track' | 'time'

export function bedEnding(cue: SoundCue): BedEnding {
  if (cue.until !== null) return 'time'
  return cue.loop ? 'episode' : 'track'
}

/**
 * Change where a bed stops. `at` is the end to use for `time` (the playhead).
 *
 * Choosing an explicit end turns looping on: without it the mix would stop at
 * the end of the file and quietly ignore the end the user just picked.
 */
export function setBedEnding(
  cue: SoundCue,
  ending: BedEnding,
  at: number,
  duration: number,
): SoundCue {
  if (cue.kind !== 'bed') return cue
  if (ending === 'episode') return { ...cue, until: null, loop: true }
  if (ending === 'track') return { ...cue, until: null, loop: false }
  return trimCue({ ...cue, loop: true }, at, duration)
}

export function formatDb(db: number): string {
  return `${db > 0 ? '+' : ''}${Math.round(db * 10) / 10} dB`
}

const KIND_LABELS: Record<SoundCueKind, string> = {
  intro: 'Intro',
  outro: 'Outro',
  bed: 'Bed',
  sfx: 'Effect',
}

export function kindLabel(kind: SoundCueKind): string {
  return KIND_LABELS[kind]
}

/** What a cue does to the mix, in words, for the lane's tooltip. */
export function cueTooltip(block: CueBlock): string {
  const { cue } = block
  const parts = [`${block.name} · ${kindLabel(cue.kind)} · ${formatDb(cue.gain_db)} under the voice`]
  if (cue.duck) parts.push(`ducks ${formatDb(cue.duck_db)} while anyone is talking`)
  if (cue.loop) parts.push('loops')
  if (block.missing) parts.push('this track is no longer in the library')
  return parts.join(' · ')
}

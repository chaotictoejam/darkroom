import { describe, expect, it } from 'vitest'
import type { LibraryTrack, SoundCue, SoundCueKind } from '../../api/types'
import {
  bedEnding, blockFor, cueBlocks, cueTooltip, formatDb, kindLabel, MIN_CUE, moveCue, newCue,
  outputDuration, replaceCue, setBedEnding, trimCue,
} from './musicCues'

const track = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 't1', name: 'Late Afternoon Loop', file: 'music/t1.flac',
  duration: 30, loudness: -14, added_at: '2026-01-01T00:00:00Z', ...over,
})

const cue = (over: Partial<SoundCue> = {}): SoundCue => ({
  id: 'c1', library_id: 't1', track: 'music', kind: 'bed', at: 0, until: null,
  length: null, gain_db: -14, duck: true, duck_db: -9, loop: true,
  fade_in: 1, fade_out: 2, ...over,
})

describe('outputDuration', () => {
  it('adds up the kept ranges', () => {
    expect(outputDuration([{ start: 0, end: 10 }, { start: 20, end: 25 }])).toBe(15)
    expect(outputDuration([])).toBe(0)
  })
})

describe('cueBlocks', () => {
  const ranges = [{ start: 0, end: 10 }, { start: 20, end: 30 }] // 10–20 cut

  it('draws a bed over its own source times', () => {
    const [block] = cueBlocks([cue({ at: 2, until: 8 })], [track()], ranges, 30)
    expect([block.start, block.end]).toEqual([2, 8])
    expect(block.name).toBe('Late Afternoon Loop')
    expect(block.missing).toBe(false)
  })

  it('runs an open-ended bed to the end of the recording', () => {
    const [block] = cueBlocks([cue({ at: 5, until: null })], [track()], ranges, 30)
    expect(block.end).toBe(30)
  })

  it('maps an intro and an outro back from the edited timeline', () => {
    // 20 s of output: an intro of 6 s covers source 0–6, an outro source 24–30
    const [intro, outro] = cueBlocks(
      [cue({ id: 'i', kind: 'intro' }), cue({ id: 'o', kind: 'outro' })],
      [track({ duration: 6 })], ranges, 30,
    )
    expect([intro.start, intro.end]).toEqual([0, 6])
    expect([outro.start, outro.end]).toEqual([24, 30])
  })

  it('clamps an intro longer than the edit to the whole edit', () => {
    const [block] = cueBlocks([cue({ kind: 'intro' })], [track({ duration: 600 })], ranges, 30)
    expect([block.start, block.end]).toEqual([0, 30])
  })

  it('gives an effect the length of its track', () => {
    const [block] = cueBlocks([cue({ kind: 'sfx', at: 4 })], [track({ duration: 2 })], ranges, 30)
    expect([block.start, block.end]).toEqual([4, 6])
  })

  it('prefers an explicit length over the track duration', () => {
    const [block] = cueBlocks([cue({ kind: 'sfx', at: 4, length: 1 })], [track()], ranges, 30)
    expect(block.end).toBe(5)
  })

  it('falls back to the whole recording when nothing is cut yet', () => {
    const [block] = cueBlocks([cue({ kind: 'intro' })], [track({ duration: 4 })], [], 30)
    expect([block.start, block.end]).toEqual([0, 4])
  })

  it('marks a cue whose library track was deleted', () => {
    const [block] = cueBlocks([cue({ library_id: 'gone' })], [track()], ranges, 30)
    expect(block.missing).toBe(true)
    expect(block.name).toBe('Missing track')
  })

  it('never draws a block narrower than MIN_CUE', () => {
    const [block] = cueBlocks([cue({ kind: 'sfx', at: 5, length: null })], [], ranges, 30)
    expect(block.end - block.start).toBeCloseTo(MIN_CUE)
  })

  it('sorts blocks along the timeline', () => {
    const blocks = cueBlocks(
      [cue({ id: 'late', kind: 'sfx', at: 20 }), cue({ id: 'early', kind: 'sfx', at: 1 })],
      [track({ duration: 1 })], ranges, 30,
    )
    expect(blocks.map((b) => b.cue.id)).toEqual(['early', 'late'])
  })
})

describe('newCue', () => {
  it('puts a bed under the voice at the playhead, looping and ducked', () => {
    const made = newCue(track(), 'bed', 42.5, 'c9')
    expect(made).toMatchObject({
      id: 'c9', library_id: 't1', kind: 'bed', at: 42.5, loop: true, duck: true,
    })
    expect(made.gain_db).toBeLessThan(0)
  })

  it('pins an intro to the start whatever the playhead is', () => {
    expect(newCue(track(), 'intro', 99, 'c1')).toMatchObject({ at: 0, gain_db: 0, loop: false })
  })

  it('leaves an effect at full level, unducked and unfaded', () => {
    expect(newCue(track(), 'sfx', 10, 'c1')).toMatchObject({
      at: 10, gain_db: 0, duck: false, loop: false, fade_in: 0, fade_out: 0,
    })
  })

  it('never places a cue before the start', () => {
    expect(newCue(track(), 'bed', -5, 'c1').at).toBe(0)
  })

  it('ducks an outro', () => {
    expect(newCue(track(), 'outro', 0, 'c1')).toMatchObject({ kind: 'outro', duck: true })
  })
})

describe('moveCue', () => {
  it('keeps a bed’s length', () => {
    expect(moveCue(cue({ at: 10, until: 40 }), 25, 100)).toMatchObject({ at: 25, until: 55 })
  })

  it('leaves an open-ended bed open', () => {
    expect(moveCue(cue({ at: 10, until: null }), 25, 100).until).toBeNull()
  })

  it('stays inside the recording', () => {
    expect(moveCue(cue({ at: 10, until: 20 }), -4, 100).at).toBe(0)
    expect(moveCue(cue({ at: 10, until: 20 }), 500, 100)).toMatchObject({
      at: 100 - MIN_CUE, until: 100,
    })
  })
})

describe('trimCue', () => {
  it('moves a bed’s end', () => {
    expect(trimCue(cue({ at: 10, until: 40 }), 30, 100).until).toBe(30)
  })

  it('never shortens it past MIN_CUE', () => {
    expect(trimCue(cue({ at: 10 }), 10.01, 100).until).toBe(10 + MIN_CUE)
  })

  it('never runs past the recording', () => {
    expect(trimCue(cue({ at: 10 }), 500, 100).until).toBe(100)
  })

  it('leaves anything that is not a bed alone', () => {
    const effect = cue({ kind: 'sfx', at: 10 })
    expect(trimCue(effect, 30, 100)).toBe(effect)
  })
})

describe('replaceCue', () => {
  it('swaps the cue with the matching id', () => {
    const cues = [cue({ id: 'a' }), cue({ id: 'b' })]
    const next = cue({ id: 'b', gain_db: -30 })
    expect(replaceCue(cues, next)).toEqual([cues[0], next])
  })
})

describe('blockFor', () => {
  it('redraws a dragged block from the cue’s own times', () => {
    const [base] = cueBlocks([cue({ at: 10, until: 20 })], [track()], [], 100)
    expect(blockFor(base, cue({ at: 30, until: 50 }))).toMatchObject({ start: 30, end: 50 })
  })

  it('keeps the length when the cue has no end', () => {
    const [base] = cueBlocks([cue({ kind: 'sfx', at: 10 })], [track({ duration: 5 })], [], 100)
    expect(blockFor(base, cue({ kind: 'sfx', at: 30 }))).toMatchObject({ start: 30, end: 35 })
  })

  it('never ends up inverted', () => {
    const [base] = cueBlocks([cue({ at: 10, until: 10.01 })], [track()], [], 100)
    const block = blockFor(base, cue({ at: 50, until: 50 }))
    expect(block.end).toBeGreaterThan(block.start)
  })
})

describe('labels', () => {
  it('formats decibels with a sign', () => {
    expect(formatDb(-14)).toBe('-14 dB')
    expect(formatDb(3.25)).toBe('+3.3 dB')
    expect(formatDb(0)).toBe('0 dB')
  })

  it('names every kind of cue', () => {
    const kinds: SoundCueKind[] = ['intro', 'outro', 'bed', 'sfx']
    expect(kinds.map(kindLabel)).toEqual(['Intro', 'Outro', 'Bed', 'Effect'])
  })

  it('says in the tooltip what a cue does to the mix', () => {
    const [block] = cueBlocks([cue()], [track()], [], 100)
    const tip = cueTooltip(block)
    expect(tip).toContain('Late Afternoon Loop')
    expect(tip).toContain('ducks -9 dB')
    expect(tip).toContain('loops')
  })

  it('leaves out what does not apply, and warns about a missing track', () => {
    const [block] = cueBlocks(
      [cue({ library_id: 'gone', duck: false, loop: false })], [track()], [], 100)
    const tip = cueTooltip(block)
    expect(tip).not.toContain('ducks')
    expect(tip).not.toContain('loops')
    expect(tip).toContain('no longer in the library')
  })
})

describe('ending a bed', () => {
  const ranges = [{ start: 0, end: 10 }, { start: 20, end: 30 }] // 10–20 cut

  it('stops a bed that does not loop where its file runs out', () => {
    const [block] = cueBlocks(
      [cue({ at: 2, until: null, loop: false })], [track({ duration: 5 })], ranges, 30)
    // Not 30: without looping the mix plays the file once and stops.
    expect(block.end).toBe(7)
  })

  it('stretches that end over a cut inside the bed', () => {
    const [block] = cueBlocks(
      [cue({ at: 5, until: null, loop: false })], [track({ duration: 8 })], ranges, 30)
    // 8 s of *edited* time from 5 s in, and 10 s of source is cut on the way.
    expect(block.end).toBe(23)
  })

  it('never runs a non-looping bed past the end the user set', () => {
    const [block] = cueBlocks(
      [cue({ at: 2, until: 4, loop: false })], [track({ duration: 30 })], ranges, 30)
    expect(block.end).toBe(4)
  })

  it('still runs to the end when the track is missing, so the cue stays visible', () => {
    const [block] = cueBlocks(
      [cue({ at: 2, until: null, loop: false, library_id: 'gone' })], [track()], ranges, 30)
    expect(block.end).toBe(30)
  })

  it('names the three states a stored bed can be in', () => {
    expect(bedEnding(cue({ until: null, loop: true }))).toBe('episode')
    expect(bedEnding(cue({ until: null, loop: false }))).toBe('track')
    expect(bedEnding(cue({ until: 12, loop: false }))).toBe('time')
  })

  it('switches a bed to the end of the episode', () => {
    const next = setBedEnding(cue({ until: 12, loop: false }), 'episode', 42, 100)
    expect([next.until, next.loop]).toEqual([null, true])
  })

  it('switches a bed to stopping when its file runs out', () => {
    const next = setBedEnding(cue({ until: 12, loop: true }), 'track', 42, 100)
    expect([next.until, next.loop]).toEqual([null, false])
  })

  it('ends a bed at the playhead, looping so it reaches that end', () => {
    const next = setBedEnding(cue({ at: 5, until: null, loop: false }), 'time', 42, 100)
    expect(next.until).toBe(42)
    // Without looping the mix would stop at the end of the file and ignore the
    // end just chosen.
    expect(next.loop).toBe(true)
  })

  it('keeps the end after the start when the playhead is behind the bed', () => {
    const next = setBedEnding(cue({ at: 50, until: null }), 'time', 10, 100)
    expect(next.until).toBeCloseTo(50 + MIN_CUE)
  })

  it('leaves an intro, outro or effect alone', () => {
    const intro = cue({ kind: 'intro', until: null })
    expect(setBedEnding(intro, 'time', 42, 100)).toBe(intro)
  })
})

import { describe, expect, it } from 'vitest'
import type { EDLSegment, TranscriptSegment, Word } from '../../api/types'
import { buildChunks, chunkAt, cutLength, PAUSE_TAIL, pauseCuts, splitTarget, type Pause } from './chunks'

function w(word: string, start: number, end: number): Word {
  return { word, start, end }
}

function segOf(...words: Word[]): TranscriptSegment {
  return { words } as TranscriptSegment
}

function edl(start: number, end: number, keep: boolean): EDLSegment {
  return { start, end, keep } as EDLSegment
}

function pause(start: number, end: number, kept = end - start): Pause {
  return { start, end, kept, locked: false }
}

describe('cutLength', () => {
  it('is 0 with no cuts', () => {
    expect(cutLength([], 0, 10)).toBe(0)
  })

  it('sums only the parts of cuts inside the range', () => {
    const cuts = [{ start: 0, end: 2 }, { start: 4, end: 5 }, { start: 9, end: 12 }]
    expect(cutLength(cuts, 1, 10)).toBe(1 + 1 + 1)
  })

  it('ignores cuts outside the range', () => {
    expect(cutLength([{ start: 20, end: 30 }], 0, 10)).toBe(0)
  })
})

describe('buildChunks', () => {
  it('returns nothing for an empty transcript', () => {
    expect(buildChunks([], [], [], [], 10)).toEqual({ phrases: [], pauses: [] })
  })

  it('groups words closer than PAUSE_MIN into one phrase, across segments and out of order', () => {
    const { phrases, pauses } = buildChunks(
      [segOf(w(' world', 0.6, 1)), segOf(w(' hello', 0, 0.5))], [], [], [], 1,
    )
    expect(phrases).toEqual([{ start: 0, end: 1, text: 'hello world', cut: false }])
    expect(pauses).toEqual([])
  })

  it('makes pauses for leading, inner and trailing silence', () => {
    const { phrases, pauses } = buildChunks(
      [segOf(w('a', 1, 2), w('b', 3, 4))], [], [], [], 6,
    )
    expect(phrases.map((p) => [p.start, p.end, p.text])).toEqual([[1, 2, 'a'], [3, 4, 'b']])
    expect(pauses).toEqual([
      { start: 0, end: 1, kept: 1, locked: false },
      { start: 2, end: 3, kept: 1, locked: false },
      { start: 4, end: 6, kept: 2, locked: false },
    ])
  })

  it('skips a trailing pause shorter than PAUSE_MIN', () => {
    const { pauses } = buildChunks([segOf(w('a', 0, 1))], [], [], [], 1.2)
    expect(pauses).toEqual([])
  })

  it('keeps a phrase that ends after a later word within it', () => {
    // The long first word overlaps the second; the phrase ends at the later end
    const { phrases } = buildChunks([segOf(w('long', 0, 3), w('short', 1, 2))], [], [], [], 3)
    expect(phrases).toEqual([{ start: 0, end: 3, text: 'long short', cut: false }])
  })

  it('marks a phrase cut only when all its words are cut', () => {
    const segments = [segOf(w('a', 0, 1), w('b', 1, 2))]
    expect(buildChunks(segments, [{ start: 0, end: 1 }], [], [], 2).phrases[0].cut).toBe(false)
    expect(buildChunks(segments, [{ start: 0, end: 2 }], [], [], 2).phrases[0].cut).toBe(true)
  })

  it('marks words cut by a dropped EDL segment, not a kept one', () => {
    const segments = [segOf(w('a', 0, 1))]
    expect(buildChunks(segments, [], [edl(0, 1, false)], [], 1).phrases[0].cut).toBe(true)
    expect(buildChunks(segments, [], [edl(0, 1, true)], [], 1).phrases[0].cut).toBe(false)
  })

  it('breaks phrases at splits and splits the words between them', () => {
    const { phrases } = buildChunks(
      [segOf(w('a', 0, 1), w('b', 1, 2), w('c', 2, 3))], [], [], [1.5], 3,
    )
    expect(phrases).toEqual([
      { start: 0, end: 1.5, text: 'a', cut: false },
      { start: 1.5, end: 3, text: 'b c', cut: false },
    ])
  })

  it('judges a split piece with no word midpoints by its own span', () => {
    // Splitting inside one word leaves a piece holding no word midpoint
    const segments = [segOf(w('word', 0, 2))]
    const [first, second] = buildChunks(segments, [{ start: 1.2, end: 2 }], [], [1.2], 2).phrases
    expect(first).toEqual({ start: 0, end: 1.2, text: 'word', cut: false })
    expect(second).toEqual({ start: 1.2, end: 2, text: '', cut: true })
  })

  it('ignores splits within SPLIT_EDGE of a chunk edge', () => {
    const { phrases } = buildChunks([segOf(w('a', 0, 1))], [], [], [0.01, 0.99], 1)
    expect(phrases).toHaveLength(1)
  })

  it('breaks pauses at splits', () => {
    const { pauses } = buildChunks([segOf(w('a', 0, 1), w('b', 3, 4))], [], [], [2], 4)
    expect(pauses).toEqual([
      { start: 1, end: 2, kept: 1, locked: false },
      { start: 2, end: 3, kept: 1, locked: false },
    ])
  })

  it('subtracts manual cuts from what a pause keeps', () => {
    const { pauses } = buildChunks([segOf(w('a', 0, 1), w('b', 3, 4))], [{ start: 1.5, end: 2.5 }], [], [], 4)
    expect(pauses[0]).toEqual({ start: 1, end: 3, kept: 1, locked: false })
  })

  it('locks a pause cut by the EDL', () => {
    const { pauses } = buildChunks([segOf(w('a', 0, 1), w('b', 3, 4))], [], [edl(1, 3, false)], [], 4)
    expect(pauses[0].locked).toBe(true)
  })

  it('locks a pause inside a manual cut that runs past both ends', () => {
    const { pauses } = buildChunks([segOf(w('a', 0, 1), w('b', 3, 4))], [{ start: 0.5, end: 3.5 }], [], [], 4)
    expect(pauses[0]).toEqual({ start: 1, end: 3, kept: 0, locked: true })
  })

  it('does not lock a pause whose manual cut ends at its edge', () => {
    const { pauses } = buildChunks([segOf(w('a', 0, 1), w('b', 3, 4))], [{ start: 1, end: 3 }], [], [], 4)
    expect(pauses[0]).toEqual({ start: 1, end: 3, kept: 0, locked: false })
  })
})

describe('chunkAt', () => {
  const chunks = [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 5, end: 6 }]

  it('returns null with no chunks', () => {
    expect(chunkAt([], 1)).toBeNull()
  })

  it('returns the chunk under t', () => {
    expect(chunkAt(chunks, 2.5)).toBe(chunks[1])
  })

  it('returns the nearest chunk before or after t', () => {
    expect(chunkAt(chunks, 3.4)).toBe(chunks[1])
    expect(chunkAt(chunks, 4.6)).toBe(chunks[2])
    expect(chunkAt(chunks, 10)).toBe(chunks[2])
  })
})

describe('splitTarget', () => {
  const chunks = [{ start: 0, end: 1 }, { start: 1, end: 2 }]

  it('returns the chunk t falls inside', () => {
    expect(splitTarget(chunks, [], 1.5)).toBe(chunks[1])
  })

  it('returns null at a chunk edge', () => {
    expect(splitTarget(chunks, [], 1.01)).toBeNull()
  })

  it('returns null outside every chunk', () => {
    expect(splitTarget(chunks, [], 5)).toBeNull()
  })

  it('returns null where there is already a split', () => {
    expect(splitTarget(chunks, [1.5], 1.51)).toBeNull()
  })
})

describe('pauseCuts', () => {
  it('cuts the middle of a pause, leaving PAUSE_TAIL before the next word', () => {
    const cuts = pauseCuts([], pause(1, 3), 0.5)
    expect(cuts).toHaveLength(1)
    expect(cuts[0].start).toBeCloseTo(1.5 - PAUSE_TAIL)
    expect(cuts[0].end).toBeCloseTo(3 - PAUSE_TAIL)
  })

  it('shrinks the tail for very short kept lengths', () => {
    const [cut] = pauseCuts([], pause(1, 3), 0.1)
    expect(cut.start).toBeCloseTo(1.05)
    expect(cut.end).toBeCloseTo(2.95)
  })

  it('replaces earlier cuts inside the pause and keeps ones outside', () => {
    const cuts = pauseCuts([{ start: 0, end: 0.5 }, { start: 1.2, end: 2.8 }], pause(1, 3), 1)
    expect(cuts).toHaveLength(2)
    expect(cuts[0]).toEqual({ start: 0, end: 0.5 })
    expect(cuts[1].start).toBeCloseTo(2 - PAUSE_TAIL)
  })

  it('removes the cut when the pause goes back to its recorded length', () => {
    expect(pauseCuts([{ start: 1.2, end: 2.8 }], pause(1, 3), 2)).toEqual([])
  })
})

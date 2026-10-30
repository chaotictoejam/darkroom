import { describe, expect, it } from 'vitest'
import type { EDLSegment } from '../../api/types'
import {
  buildKeptRanges,
  mergeAndSortCuts,
  outputToSourceTime,
  sourceToOutputTime,
  subtractRange,
  type TimeRange,
} from './timeMap'

function seg(start: number, end: number, keep: boolean): EDLSegment {
  return { start, end, keep } as EDLSegment
}

describe('mergeAndSortCuts', () => {
  it('returns an empty list for no cuts', () => {
    expect(mergeAndSortCuts([])).toEqual([])
  })

  it('sorts cuts by start', () => {
    expect(mergeAndSortCuts([{ start: 5, end: 6 }, { start: 1, end: 2 }]))
      .toEqual([{ start: 1, end: 2 }, { start: 5, end: 6 }])
  })

  it('merges overlapping and contained cuts', () => {
    expect(mergeAndSortCuts([{ start: 1, end: 3 }, { start: 2, end: 4 }, { start: 2.5, end: 3 }]))
      .toEqual([{ start: 1, end: 4 }])
  })

  it('merges cuts separated by a gap of up to 0.05 s', () => {
    expect(mergeAndSortCuts([{ start: 1, end: 2 }, { start: 2.04, end: 3 }]))
      .toEqual([{ start: 1, end: 3 }])
    expect(mergeAndSortCuts([{ start: 1, end: 2 }, { start: 2.1, end: 3 }]))
      .toHaveLength(2)
  })

  it('does not change its input', () => {
    const cuts = [{ start: 2, end: 4 }, { start: 1, end: 3 }]
    mergeAndSortCuts(cuts)
    expect(cuts).toEqual([{ start: 2, end: 4 }, { start: 1, end: 3 }])
  })
})

describe('subtractRange', () => {
  const cuts = [{ start: 1, end: 2 }, { start: 4, end: 8 }, { start: 10, end: 11 }]

  it('keeps cuts outside the range, including ones that only touch it', () => {
    expect(subtractRange(cuts, 2, 4)).toEqual(cuts)
  })

  it('splits a cut that spans the range', () => {
    expect(subtractRange(cuts, 5, 6)).toEqual([
      { start: 1, end: 2 }, { start: 4, end: 5 }, { start: 6, end: 8 }, { start: 10, end: 11 },
    ])
  })

  it('trims cuts that overlap either end and removes covered ones', () => {
    expect(subtractRange(cuts, 1.5, 10.5)).toEqual([{ start: 1, end: 1.5 }, { start: 10.5, end: 11 }])
  })
})

describe('buildKeptRanges', () => {
  it('keeps the whole recording when there is no EDL or cut', () => {
    expect(buildKeptRanges([], [], 60)).toEqual([{ start: 0, end: 60 }])
  })

  it('keeps only the EDL segments marked keep', () => {
    expect(buildKeptRanges([seg(0, 10, true), seg(10, 20, false), seg(20, 30, true)], [], 30))
      .toEqual([{ start: 0, end: 10 }, { start: 20, end: 30 }])
  })

  it('splits kept ranges around word cuts', () => {
    expect(buildKeptRanges([], [{ start: 5, end: 7 }], 20))
      .toEqual([{ start: 0, end: 5 }, { start: 7, end: 20 }])
  })

  it('applies a cut that spans two kept ranges to both', () => {
    expect(buildKeptRanges([seg(0, 10, true), seg(12, 20, true)], [{ start: 8, end: 14 }], 20))
      .toEqual([{ start: 0, end: 8 }, { start: 14, end: 20 }])
  })

  it('leaves kept ranges before and after a cut untouched', () => {
    expect(buildKeptRanges([seg(0, 10, true), seg(20, 30, true), seg(40, 50, true)], [{ start: 22, end: 24 }], 50))
      .toEqual([{ start: 0, end: 10 }, { start: 20, end: 22 }, { start: 24, end: 30 }, { start: 40, end: 50 }])
  })

  it('handles cuts at the very start and end', () => {
    expect(buildKeptRanges([], [{ start: 0, end: 2 }, { start: 18, end: 20 }], 20))
      .toEqual([{ start: 2, end: 18 }])
  })

  it('drops slivers shorter than two frames', () => {
    expect(buildKeptRanges([], [{ start: 0, end: 5 }, { start: 5.05, end: 10 }], 10)).toEqual([])
  })
})

describe('source ↔ output time', () => {
  // 0–10 kept, 10–15 cut, 15–20 kept, 20–30 cut, 30–40 kept → 25 s of output
  const kept: TimeRange[] = [{ start: 0, end: 10 }, { start: 15, end: 20 }, { start: 30, end: 40 }]

  it.each([
    [0, 0],
    [4, 4],
    [10, 10],
    [12, 10], // inside a cut: snaps to where the cut starts in the output
    [17, 12],
    [25, 15],
    [35, 20],
    [40, 25],
    [99, 25], // past the end
  ])('source %d s → output %d s', (source, output) => {
    expect(sourceToOutputTime(source, kept)).toBeCloseTo(output)
  })

  it.each([
    [0, 0],
    [4, 4],
    [12, 17],
    [20, 35],
    [25, 40],
  ])('output %d s → source %d s', (output, source) => {
    expect(outputToSourceTime(output, kept)).toBeCloseTo(source)
  })

  it('maps output past the end to the end of the last kept range', () => {
    expect(outputToSourceTime(99, kept)).toBe(40)
  })

  it('maps everything to 0 when nothing is kept', () => {
    expect(sourceToOutputTime(5, [])).toBe(0)
    expect(outputToSourceTime(5, [])).toBe(0)
  })

  it('round-trips any time inside a kept range', () => {
    for (let t = 0; t <= 40; t += 0.25) {
      if (!kept.some((r) => t > r.start && t < r.end)) continue
      expect(outputToSourceTime(sourceToOutputTime(t, kept), kept)).toBeCloseTo(t)
    }
  })
})

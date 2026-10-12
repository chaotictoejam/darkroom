/**
 * Cut and time-mapping helpers shared by the editor, timeline and preview.
 */
import type { EDLSegment, WordCut } from '../../api/types'

export function mergeAndSortCuts(cuts: WordCut[]): WordCut[] {
  if (cuts.length === 0) return []
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const merged: WordCut[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i].start <= last.end + 0.05) {
      last.end = Math.max(last.end, sorted[i].end)
    } else {
      merged.push({ ...sorted[i] })
    }
  }
  return merged
}

// ── Time-mapping utilities ─────────────────────────────────────────────────────
// The proxy video is the rendered output (all cuts applied). These functions
// convert between source-file time and output-timeline time so that seeking
// and transcript highlighting stay in sync regardless of which player is active.

export type TimeRange = { start: number; end: number }

/** Build the list of kept source ranges, accounting for EDL + word cuts. */
export function buildKeptRanges(
  edlSegments: EDLSegment[],
  wordCuts: WordCut[],
  totalDuration: number,
): TimeRange[] {
  let ranges: TimeRange[] =
    edlSegments.length > 0
      ? edlSegments.filter((s) => s.keep).map((s) => ({ start: s.start, end: s.end }))
      : [{ start: 0, end: totalDuration }]

  for (const cut of wordCuts) {
    ranges = ranges.flatMap((r) => {
      if (cut.end <= r.start || cut.start >= r.end) return [r]
      const pieces: TimeRange[] = []
      if (cut.start > r.start) pieces.push({ start: r.start, end: cut.start })
      if (cut.end < r.end) pieces.push({ start: cut.end, end: r.end })
      return pieces
    })
  }
  return ranges.filter((r) => r.end - r.start > 0.067) // drop sub-2-frame slivers
}

/** Source time → position in the output/proxy timeline. */
export function sourceToOutputTime(sourceTime: number, keptRanges: TimeRange[]): number {
  let out = 0
  for (const r of keptRanges) {
    if (sourceTime <= r.start) break
    if (sourceTime >= r.end) {
      out += r.end - r.start
    } else {
      out += sourceTime - r.start
      break
    }
  }
  return out
}

/** Output/proxy timeline position → source file time. */
export function outputToSourceTime(outputTime: number, keptRanges: TimeRange[]): number {
  let rem = outputTime
  for (const r of keptRanges) {
    const len = r.end - r.start
    if (rem <= len) return r.start + rem
    rem -= len
  }
  return keptRanges[keptRanges.length - 1]?.end ?? 0
}

/**
 * Timeline word-lane chunks. Words closer than PAUSE_MIN form one phrase chip;
 * longer gaps (including leading and trailing silence) become pause chips.
 * User splits then break any chip in two at the split time. Times are in
 * source seconds.
 */
import type { EDLSegment, TranscriptSegment, WordCut } from '../../api/types'
import { mergeAndSortCuts, subtractRange } from './timeMap'

export const PAUSE_MIN = 0.3    // seconds — shorter gaps stay inside a phrase chip
export const PAUSE_TAIL = 0.08  // seconds — kept just before the next word when shortening a pause
export const SPLIT_EDGE = 0.02  // seconds — splits closer than this to a chunk edge are ignored

export type Phrase = { start: number; end: number; text: string; cut: boolean }
/** A silence between words; `kept` is how much of it survives the cuts. */
export type Pause = { start: number; end: number; kept: number; locked: boolean }
/** A chip in the word lane — a phrase or a pause. */
export type Chunk = { start: number; end: number }

/** Seconds of [start, end] covered by the (merged, non-overlapping) cuts. */
export function cutLength(cuts: WordCut[], start: number, end: number): number {
  return cuts.reduce((sum, c) => sum + Math.max(0, Math.min(end, c.end) - Math.max(start, c.start)), 0)
}

/** Phrase and pause chips for the transcript, marked against the cuts and broken at the splits. */
export function buildChunks(
  segments: TranscriptSegment[],
  wordCuts: WordCut[],
  edlSegments: EDLSegment[],
  splits: number[],
  duration: number,
): { phrases: Phrase[]; pauses: Pause[] } {
  const words = segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start)
  const edlCuts = edlSegments.filter((s) => !s.keep)
  const isCut = (start: number, end: number) => {
    const mid = (start + end) / 2
    return wordCuts.some((c) => c.start <= mid && c.end >= mid)
      || edlCuts.some((s) => s.start <= mid && s.end > mid)
  }
  /** [start, end] broken at the splits strictly inside it. */
  const pieces = (start: number, end: number): Array<[number, number]> => {
    const points = [start, ...splits.filter((t) => t > start + SPLIT_EDGE && t < end - SPLIT_EDGE), end]
    return points.slice(1).map((t, i) => [points[i], t])
  }
  const phrases: Phrase[] = []
  const pauses: Pause[] = []
  const addPhrase = (start: number, end: number, ws: typeof words) => {
    for (const [ps, pe] of pieces(start, end)) {
      const inside = ws.filter((w) => (w.start + w.end) / 2 >= ps && (w.start + w.end) / 2 < pe)
      phrases.push({
        start: ps, end: pe,
        text: inside.map((w) => w.word.trim()).join(' '),
        cut: inside.length > 0 ? inside.every((w) => isCut(w.start, w.end)) : isCut(ps, pe),
      })
    }
  }
  const addPause = (start: number, end: number) => {
    for (const [ps, pe] of pieces(start, end)) {
      // Locked: cut by the EDL, or inside a manual cut that runs past both ends
      const locked = edlCuts.some((s) => s.start < pe - 0.05 && s.end > ps + 0.05)
        || wordCuts.some((c) => c.start < ps - 0.01 && c.end > pe + 0.01)
      pauses.push({ start: ps, end: pe, kept: Math.max(0, pe - ps - cutLength(wordCuts, ps, pe)), locked })
    }
  }
  let current: { start: number; end: number; words: typeof words } | null = null
  let lastEnd = 0
  for (const w of words) {
    if (w.start - lastEnd >= PAUSE_MIN) {
      if (current) addPhrase(current.start, current.end, current.words)
      current = null
      addPause(lastEnd, w.start)
    }
    if (!current) current = { start: w.start, end: w.end, words: [] }
    current.words.push(w)
    current.end = Math.max(current.end, w.end)
    lastEnd = Math.max(lastEnd, w.end)
  }
  if (current) addPhrase(current.start, current.end, current.words)
  if (words.length > 0 && duration - lastEnd >= PAUSE_MIN) addPause(lastEnd, duration)
  return { phrases, pauses }
}

/** The chunk under time t, or the nearest one; `chunks` sorted by start. */
export function chunkAt(chunks: Chunk[], t: number): Chunk | null {
  let best: Chunk | null = null
  let bestDist = Infinity
  for (const c of chunks) {
    const dist = t < c.start ? c.start - t : t > c.end ? t - c.end : 0
    if (dist < bestDist) { best = c; bestDist = dist }
    if (dist === 0) break
  }
  return best
}

/** The chunk a split at t would break, or null if t is on an edge or already split. */
export function splitTarget(chunks: Chunk[], splits: number[], t: number): Chunk | null {
  if (splits.some((s) => Math.abs(s - t) < SPLIT_EDGE)) return null
  return chunks.find((c) => t > c.start + SPLIT_EDGE && t < c.end - SPLIT_EDGE) ?? null
}

/** Cuts that keep `kept` seconds of a pause: its middle is cut, leaving a short tail before the next word. */
export function pauseCuts(wordCuts: WordCut[], pause: Pause, kept: number): WordCut[] {
  let cuts = subtractRange(wordCuts, pause.start, pause.end)
  if (pause.end - pause.start - kept > 0.02) {
    const tail = Math.min(PAUSE_TAIL, kept / 2)
    cuts = [...cuts, { start: pause.start + kept - tail, end: pause.end - tail }]
  }
  return mergeAndSortCuts(cuts)
}

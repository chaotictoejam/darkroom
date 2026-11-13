/**
 * The transcript of the *edit*, not of the source recording: only the words a
 * listener still hears (EDL keeps, minus word cuts and mutes), timestamped in
 * the exported file's timeline. Same rules as the renders and DarkRelay
 * bundles (`_apply_word_cuts` / `edited_words` in the backend).
 */
import type { Project, TranscriptSegment, WordMute } from '../../api/types'
import { formatTimestamp } from '../../formatTime'
import { buildKeptRanges, type TimeRange } from '../Timeline/timeMap'

/** A gap in *source* time this long starts a new block — a cut, or a real pause. */
export const BLOCK_GAP = 1.0

/** A word that survives the edit; `start`/`end` are edited time, `sourceEnd` source time. */
export type EditedWord = {
  text: string
  start: number
  end: number
  source: number
  sourceEnd: number
  speaker: string
}

/** A paragraph of the edited transcript, in edited time. */
export type TranscriptBlock = { speaker: string; start: number; end: number; text: string }

/** The kept piece holding source time `t`, with the edited time it starts at. */
function pieceAt(t: number, ranges: TimeRange[]): { offset: number; start: number; end: number } | null {
  let offset = 0
  for (const r of ranges) {
    if (t >= r.start && t <= r.end) return { offset, start: r.start, end: r.end }
    offset += r.end - r.start
  }
  return null
}

/**
 * Every word still heard, in edited time. A word is judged by its midpoint, so
 * one straddling a cut keeps only the part that survives; muted words are left
 * out because they are silent in the export.
 */
export function editedWords(
  segments: TranscriptSegment[],
  keptRanges: TimeRange[],
  mutes: WordMute[],
): EditedWord[] {
  const words: EditedWord[] = []
  for (const seg of segments) {
    for (const w of seg.words ?? []) {
      const text = w.word.trim()
      if (!text) continue
      const mid = (w.start + w.end) / 2
      if (mutes.some((m) => m.start <= mid && mid <= m.end)) continue
      const piece = pieceAt(mid, keptRanges)
      if (!piece) continue
      words.push({
        text,
        start: piece.offset + Math.max(w.start, piece.start) - piece.start,
        end: piece.offset + Math.min(w.end, piece.end) - piece.start,
        source: w.start,
        sourceEnd: w.end,
        speaker: seg.speaker_name || seg.speaker_id,
      })
    }
  }
  words.sort((a, b) => a.start - b.start)
  return words
}

/** Group words into blocks, breaking on a speaker change or a gap in the source. */
export function transcriptBlocks(words: EditedWord[]): TranscriptBlock[] {
  const blocks: Array<TranscriptBlock & { sourceEnd: number }> = []
  for (const w of words) {
    const cur = blocks[blocks.length - 1]
    if (cur && cur.speaker === w.speaker && w.source - cur.sourceEnd <= BLOCK_GAP) {
      cur.text += ' ' + w.text
      cur.end = Math.max(cur.end, w.end)
      cur.sourceEnd = Math.max(cur.sourceEnd, w.sourceEnd)
    } else {
      blocks.push({ speaker: w.speaker, start: w.start, end: w.end, text: w.text, sourceEnd: w.sourceEnd })
    }
  }
  return blocks.map(({ speaker, start, end, text }) => ({ speaker, start, end, text }))
}

export function transcriptText(blocks: TranscriptBlock[]): string {
  return blocks
    .map((b) => `[${formatTimestamp(b.start)} - ${formatTimestamp(b.end)}]${b.speaker ? ' ' + b.speaker : ''}\n${b.text}`)
    .join('\n\n')
}

/**
 * The edited transcript as text. `duration` is the source duration the player
 * reports; with no EDL and no cuts this is the whole transcript, unshifted.
 */
export function editedTranscriptText(project: Project, duration: number): string {
  const segments = project.merged_transcript ?? []
  // The player may not have reported a duration yet; the transcript's end does.
  const total = duration || segments.reduce((max, s) => Math.max(max, s.end), 0)
  const ranges = buildKeptRanges(project.edl?.segments ?? [], project.word_cuts ?? [], total)
  return transcriptText(transcriptBlocks(editedWords(segments, ranges, project.word_mutes ?? [])))
}

/**
 * TranscriptEditor — word-level transcript editing.
 *
 * Interactions:
 *   Click a word          → seeks the video to that word's start time
 *   Click + drag          → selects a range of words
 *   Shift+click           → extends selection to that word
 *   Delete / Backspace    → cuts the selected words' time range
 *   Ctrl+Z / Cmd+Z        → undoes the last cut
 *
 * Visual states:
 *   Normal                → plain text
 *   Selected              → blue highlight (pending cut)
 *   Cut (in word_cuts)    → red strikethrough + dimmed
 *   Active (playing now)  → yellow/accent underline
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriptSegment, WordCut } from '../../api/types'

// ── Flat word model ───────────────────────────────────────────────────────────

interface FlatWord {
  globalIndex: number
  segIndex: number
  wordIndex: number
  word: string
  start: number
  end: number
}

function flattenWords(segments: TranscriptSegment[]): FlatWord[] {
  const out: FlatWord[] = []
  let g = 0
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    for (let wi = 0; wi < seg.words.length; wi++) {
      const w = seg.words[wi]
      out.push({ globalIndex: g++, segIndex: si, wordIndex: wi, word: w.word, start: w.start, end: w.end })
    }
  }
  return out
}

function isCut(word: FlatWord, cuts: WordCut[]): boolean {
  return cuts.some((c) => word.start >= c.start - 0.01 && word.end <= c.end + 0.01)
}

function mergeAndSort(cuts: WordCut[]): WordCut[] {
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

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  segments: TranscriptSegment[]
  wordCuts: WordCut[]
  /** Current video playback time — used to highlight the active word. */
  currentTime: number
  onSeek: (time: number) => void
  /** Called whenever the cut list changes (after delete or undo). */
  onCutsChange: (cuts: WordCut[]) => void
}

export default function TranscriptEditor({
  segments,
  wordCuts,
  currentTime,
  onSeek,
  onCutsChange,
}: Props) {
  const words = useRef<FlatWord[]>(flattenWords(segments))
  const [selRange, setSelRange] = useState<{ anchor: number; focus: number } | null>(null)
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Re-flatten if segments change
  useEffect(() => {
    words.current = flattenWords(segments)
  }, [segments])

  // ── Active word index ─────────────────────────────────────────────────────
  const activeIndex = words.current.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  )

  // ── Selection helpers ──────────────────────────────────────────────────────
  const selStart = selRange ? Math.min(selRange.anchor, selRange.focus) : -1
  const selEnd   = selRange ? Math.max(selRange.anchor, selRange.focus) : -1
  const isSelected = (i: number) => i >= selStart && i <= selEnd

  // ── Keyboard: Delete / Ctrl+Z ─────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Delete or Backspace with a selection → cut
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRange !== null) {
        e.preventDefault()
        const selected = words.current.filter((w) => isSelected(w.globalIndex))
        if (selected.length === 0) return
        const newCut: WordCut = {
          start: selected[0].start,
          end: selected[selected.length - 1].end,
        }
        onCutsChange(mergeAndSort([...wordCuts, newCut]))
        setSelRange(null)
        return
      }

      // Ctrl+Z / Cmd+Z → undo last cut
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && wordCuts.length > 0) {
        e.preventDefault()
        onCutsChange(wordCuts.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selRange, wordCuts, onCutsChange])

  // Clear selection on click outside transcript
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSelRange(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // ── Word pointer handlers ──────────────────────────────────────────────────
  function onWordPointerDown(e: React.PointerEvent, idx: number) {
    e.preventDefault()
    isDragging.current = true
    if (e.shiftKey && selRange) {
      setSelRange({ anchor: selRange.anchor, focus: idx })
    } else {
      setSelRange({ anchor: idx, focus: idx })
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onWordPointerEnter(idx: number) {
    if (isDragging.current) {
      setSelRange((prev) => prev ? { anchor: prev.anchor, focus: idx } : { anchor: idx, focus: idx })
    }
  }

  function onWordPointerUp(e: React.PointerEvent, idx: number, word: FlatWord) {
    isDragging.current = false
    // Single click (anchor === focus) on a non-cut word → seek
    if (selRange && selRange.anchor === idx && selRange.focus === idx) {
      onSeek(word.start)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Group words back by segment to show speaker labels
  const grouped: { segIndex: number; label: string; words: FlatWord[] }[] = []
  for (const w of words.current) {
    const last = grouped[grouped.length - 1]
    if (last && last.segIndex === w.segIndex) {
      last.words.push(w)
    } else {
      grouped.push({
        segIndex: w.segIndex,
        label: segments[w.segIndex]?.speaker_name ?? '',
        words: [w],
      })
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        outline: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        lineHeight: 1.9,
        fontSize: 15,
      }}
    >
      {selRange !== null && selStart !== selEnd && (
        <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          {selEnd - selStart + 1} words selected — press <kbd style={{ background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 3 }}>Delete</kbd> to cut
        </div>
      )}

      {grouped.map((group) => (
        <div key={group.segIndex} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 4, letterSpacing: 0.5 }}>
            {group.label}
          </div>
          <div>
            {group.words.map((w) => {
              const cut      = isCut(w, wordCuts)
              const selected = isSelected(w.globalIndex)
              const active   = w.globalIndex === activeIndex

              return (
                <span
                  key={w.globalIndex}
                  onPointerDown={(e) => onWordPointerDown(e, w.globalIndex)}
                  onPointerEnter={() => onWordPointerEnter(w.globalIndex)}
                  onPointerUp={(e) => onWordPointerUp(e, w.globalIndex, w)}
                  style={{
                    display: 'inline-block',
                    marginRight: 3,
                    paddingLeft: 1,
                    paddingRight: 1,
                    borderRadius: 3,
                    cursor: 'pointer',
                    transition: 'background 0.05s',
                    // Priority: selected > active > cut > normal
                    background: selected
                      ? 'rgba(59,130,246,0.35)'
                      : 'transparent',
                    color: cut ? 'var(--text-muted)' : 'inherit',
                    textDecoration: cut ? 'line-through' : 'none',
                    opacity: cut ? 0.45 : 1,
                    borderBottom: active && !cut
                      ? '2px solid var(--accent)'
                      : '2px solid transparent',
                  }}
                >
                  {w.word.trimStart()}
                </span>
              )
            })}
          </div>
        </div>
      ))}

      {wordCuts.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          {wordCuts.length} cut{wordCuts.length !== 1 ? 's' : ''} · <button
            onClick={() => onCutsChange(wordCuts.slice(0, -1))}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            Undo last (Ctrl+Z)
          </button>
          {' · '}
          <button
            onClick={() => onCutsChange([])}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            Clear all cuts
          </button>
        </div>
      )}
    </div>
  )
}

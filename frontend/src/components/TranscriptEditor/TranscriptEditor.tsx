/**
 * TranscriptEditor — word-level transcript editing.
 *
 * Interactions:
 *   Click a word          → seeks the video + shows floating toolbar
 *   Click + drag          → selects a range of words + shows toolbar
 *   Shift+click           → extends selection
 *   Delete / Backspace    → cuts the selected words' time range
 *   Ctrl+Z / Cmd+Z        → undoes the last cut
 *
 * Visual states:
 *   Normal                → plain text
 *   Selected              → blue highlight (pending cut)
 *   Word-cut              → red strikethrough + dimmed
 *   EDL-cut               → gray strikethrough + dimmed
 *   Active (playing)      → accent underline
 */
import { useEffect, useRef, useState } from 'react'
import type { EDLSegment, TranscriptSegment, WordCut, WordMute } from '../../api/types'

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

function isEdlCut(word: FlatWord, segments: EDLSegment[]): boolean {
  return segments.some((s) => !s.keep && word.start < s.end && word.end > s.start)
}

function isMuted(word: FlatWord, mutes: WordMute[]): boolean {
  return mutes.some((m) => word.start < m.end && word.end > m.start)
}

function getEdlSegment(word: FlatWord, segments: EDLSegment[]): EDLSegment | null {
  return segments.find((s) => word.start < s.end && word.end > s.start) ?? null
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
  wordMutes?: WordMute[]
  /** EDL segments from AI analysis — keep=false words are shown grayed + struck. */
  edlSegments?: EDLSegment[]
  /** Current video playback time — used to highlight the active word. */
  currentTime: number
  onSeek: (time: number) => void
  /** Called whenever the cut list changes (after delete or undo). */
  onCutsChange: (cuts: WordCut[]) => void
  onMutesChange: (mutes: WordMute[]) => void
}

interface ToolbarState {
  x: number        // fixed screen x (center of toolbar)
  y: number        // fixed screen y (top of anchor word — toolbar renders above)
  selStart: number // global word index start of selection
  selEnd: number   // global word index end of selection (inclusive)
}

export default function TranscriptEditor({
  segments,
  wordCuts,
  wordMutes = [],
  edlSegments = [],
  currentTime,
  onSeek,
  onCutsChange,
  onMutesChange,
}: Props) {
  const words = useRef<FlatWord[]>(flattenWords(segments))
  const [selRange, setSelRange] = useState<{ anchor: number; focus: number } | null>(null)
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null)
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    words.current = flattenWords(segments)
  }, [segments])

  // ── Active word ───────────────────────────────────────────────────────────
  const activeIndex = words.current.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  )

  // ── Selection helpers ──────────────────────────────────────────────────────
  const selStart = selRange ? Math.min(selRange.anchor, selRange.focus) : -1
  const selEnd   = selRange ? Math.max(selRange.anchor, selRange.focus) : -1
  const isSelected = (i: number) => i >= selStart && i <= selEnd

  // ── Toolbar actions ────────────────────────────────────────────────────────
  function openToolbar(anchorIdx: number, endIdx: number) {
    const el = containerRef.current?.querySelector(`[data-gidx="${anchorIdx}"]`)
    if (!el) return
    const rect = el.getBoundingClientRect()
    setToolbar({
      x: rect.left + rect.width / 2,
      y: rect.top,
      selStart: anchorIdx,
      selEnd: endIdx,
    })
  }

  function cutToolbarSelection() {
    if (!toolbar) return
    const selected = words.current.filter(
      (w) => w.globalIndex >= toolbar.selStart && w.globalIndex <= toolbar.selEnd,
    )
    if (selected.length === 0) return
    const newCut: WordCut = { start: selected[0].start, end: selected[selected.length - 1].end }
    onCutsChange(mergeAndSort([...wordCuts, newCut]))
    setToolbar(null)
    setSelRange(null)
  }

  function restoreToolbarSelection() {
    if (!toolbar) return
    const selected = words.current.filter(
      (w) => w.globalIndex >= toolbar.selStart && w.globalIndex <= toolbar.selEnd,
    )
    if (selected.length === 0) return
    const rangeStart = selected[0].start
    const rangeEnd   = selected[selected.length - 1].end
    onCutsChange(wordCuts.filter((c) => c.end <= rangeStart || c.start >= rangeEnd))
    setToolbar(null)
  }

  function muteToolbarSelection() {
    if (!toolbar) return
    const selected = words.current.filter(
      (w) => w.globalIndex >= toolbar.selStart && w.globalIndex <= toolbar.selEnd,
    )
    if (selected.length === 0) return
    const newMute: WordMute = { start: selected[0].start, end: selected[selected.length - 1].end }
    const merged = mergeAndSort([...wordMutes, newMute])
    onMutesChange(merged)
    setToolbar(null)
    setSelRange(null)
  }

  function unmuteToolbarSelection() {
    if (!toolbar) return
    const selected = words.current.filter(
      (w) => w.globalIndex >= toolbar.selStart && w.globalIndex <= toolbar.selEnd,
    )
    if (selected.length === 0) return
    const rangeStart = selected[0].start
    const rangeEnd   = selected[selected.length - 1].end
    onMutesChange(wordMutes.filter((m) => m.end <= rangeStart || m.start >= rangeEnd))
    setToolbar(null)
  }

  // ── Keyboard: Delete / Ctrl+Z ─────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRange !== null) {
        e.preventDefault()
        const selected = words.current.filter((w) => isSelected(w.globalIndex))
        if (selected.length === 0) return
        const newCut: WordCut = { start: selected[0].start, end: selected[selected.length - 1].end }
        onCutsChange(mergeAndSort([...wordCuts, newCut]))
        setSelRange(null)
        setToolbar(null)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && wordCuts.length > 0) {
        e.preventDefault()
        onCutsChange(wordCuts.slice(0, -1))
      }
      if (e.key === 'Escape') {
        setToolbar(null)
        setSelRange(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selRange, wordCuts, onCutsChange])

  // ── Close toolbar / selection on outside click ─────────────────────────────
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      // Keep toolbar open if clicking inside it (toolbar is outside containerRef)
      if (containerRef.current?.contains(target)) return
      const toolbarEl = document.getElementById('transcript-toolbar')
      if (toolbarEl?.contains(target)) return
      setSelRange(null)
      setToolbar(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // ── Word pointer handlers ──────────────────────────────────────────────────
  function onWordPointerDown(e: React.PointerEvent, idx: number) {
    e.preventDefault()
    isDragging.current = true
    setToolbar(null)
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
    const start = selRange ? Math.min(selRange.anchor, selRange.focus) : idx
    const end   = selRange ? Math.max(selRange.anchor, selRange.focus) : idx

    // Single click → seek video
    if (start === end) onSeek(word.start)

    // Show toolbar above the anchor word
    openToolbar(start, end)
  }

  // ── Render ────────────────────────────────────────────────────────────────
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

  // Derive toolbar context
  const toolbarWords = toolbar
    ? words.current.filter((w) => w.globalIndex >= toolbar.selStart && w.globalIndex <= toolbar.selEnd)
    : []
  const anyWordCut   = toolbarWords.some((w) => isCut(w, wordCuts))
  const allWordCut   = toolbarWords.length > 0 && toolbarWords.every((w) => isCut(w, wordCuts))
  const anyWordMuted = toolbarWords.some((w) => isMuted(w, wordMutes))
  const anchorEdlSeg = toolbarWords.length > 0 ? getEdlSegment(toolbarWords[0], edlSegments) : null

  return (
    <>
      {/* ── Floating toolbar ─────────────────────────────────────────────── */}
      {toolbar && (
        <div
          id="transcript-toolbar"
          style={{
            position: 'fixed',
            left: toolbar.x,
            top: toolbar.y - 48,
            transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex', alignItems: 'center', gap: 1,
            background: '#1c1c1c',
            border: '1px solid #3a3a3a',
            borderRadius: 8,
            padding: '3px 4px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            fontSize: 13,
            whiteSpace: 'nowrap',
          }}
        >
          {/* EDL segment badge */}
          {anchorEdlSeg && (
            <>
              <span style={{
                padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                background: anchorEdlSeg.keep ? 'rgba(50,180,100,0.15)' : 'rgba(200,50,50,0.15)',
                color: anchorEdlSeg.keep ? '#4db87a' : '#e05555',
                letterSpacing: '0.05em',
              }}>
                {anchorEdlSeg.keep ? '✓ KEEP' : '✕ CUT'}
              </span>
              <span style={{ color: 'var(--accent)', padding: '3px 6px', fontSize: 11, fontWeight: 600 }}>
                {anchorEdlSeg.camera}
              </span>
              {anchorEdlSeg.reason && (
                <span style={{ padding: '3px 8px', color: '#888', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {anchorEdlSeg.reason}
                </span>
              )}
              <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />
            </>
          )}

          {/* Cut / Restore */}
          {allWordCut ? (
            <ToolbarBtn label="Restore" onClick={restoreToolbarSelection} color="#4db87a" />
          ) : anyWordCut ? (
            <>
              <ToolbarBtn label="Cut" onClick={cutToolbarSelection} />
              <ToolbarBtn label="Restore" onClick={restoreToolbarSelection} color="#4db87a" />
            </>
          ) : (
            <ToolbarBtn label="Cut" onClick={cutToolbarSelection} />
          )}

          <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />

          {/* Mute / Unmute */}
          {anyWordMuted
            ? <ToolbarBtn label="🔊 Unmute" onClick={unmuteToolbarSelection} />
            : <ToolbarBtn label="🔇 Mute" onClick={muteToolbarSelection} />
          }
        </div>
      )}

      {/* ── Transcript ───────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        tabIndex={0}
        style={{ outline: 'none', userSelect: 'none', WebkitUserSelect: 'none', lineHeight: 1.9, fontSize: 15 }}
      >
        {grouped.map((group) => (
          <div key={group.segIndex} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 4, letterSpacing: 0.5 }}>
              {group.label}
            </div>
            <div>
              {group.words.map((w) => {
                const cut      = isCut(w, wordCuts)
                const edlCut   = !cut && isEdlCut(w, edlSegments)
                const muted    = !cut && isMuted(w, wordMutes)
                const selected = isSelected(w.globalIndex)
                const active   = w.globalIndex === activeIndex

                return (
                  <span
                    key={w.globalIndex}
                    data-gidx={w.globalIndex}
                    onPointerDown={(e) => onWordPointerDown(e, w.globalIndex)}
                    onPointerEnter={() => onWordPointerEnter(w.globalIndex)}
                    onPointerUp={(e) => onWordPointerUp(e, w.globalIndex, w)}
                    style={{
                      display: 'inline-block',
                      marginRight: 3, paddingLeft: 2, paddingRight: 2,
                      borderRadius: 3, cursor: 'pointer',
                      transition: 'background 0.05s',
                      background: selected
                        ? 'rgba(59,130,246,0.35)'
                        : muted ? 'rgba(180,120,0,0.18)' : 'transparent',
                      color: cut ? '#e05555' : edlCut ? 'var(--text-muted)' : 'inherit',
                      textDecoration: cut || edlCut ? 'line-through' : 'none',
                      opacity: cut ? 0.45 : edlCut ? 0.4 : 1,
                      borderBottom: active && !cut && !edlCut
                        ? '2px solid var(--accent)'
                        : muted ? '2px solid rgba(180,120,0,0.5)' : '2px solid transparent',
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
            {wordCuts.length} cut{wordCuts.length !== 1 ? 's' : ''} ·{' '}
            <button
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
    </>
  )
}

// ── Toolbar button ─────────────────────────────────────────────────────────────

function ToolbarBtn({ label, onClick, color }: { label: string; onClick: () => void; color?: string }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{
        background: 'none', border: 'none',
        color: color ?? '#e0e0e0',
        padding: '4px 10px', borderRadius: 5,
        fontSize: 13, fontWeight: 500,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2e2e2e' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
    >
      {label}
    </button>
  )
}

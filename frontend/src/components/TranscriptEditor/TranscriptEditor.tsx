/**
 * TranscriptEditor — word-level transcript editing.
 *
 * Interactions:
 *   Click a word          → seeks the video + shows floating toolbar
 *   Double-click a word   → selects the entire segment
 *   Click + drag          → selects a range of words + shows toolbar
 *   Shift+click           → extends selection
 *   Delete / Backspace    → cuts the selected words' time range
 *   Space                 → toggles video play/pause
 *   Ctrl+Z / Cmd+Z        → undoes the last cut
 *   Click a pause squiggle → selects it + shows toolbar (Cut pause / Restore)
 *
 * Visual states:
 *   Normal                → plain text
 *   Selected              → blue highlight (pending cut)
 *   Word-cut              → red strikethrough + dimmed (or hidden in clean view)
 *   EDL-cut               → gray strikethrough + dimmed (or hidden in clean view)
 *   Active (playing)      → accent underline
 *   Gap chip              → [x.xs] inline badge shown in clean view where cuts were made
 *   Pause squiggle        → 〜 between words with a natural gap ≥0.4s; a longer pause renders
 *                           as one 〜 per ~0.4s chunk, each independently selectable/cuttable —
 *                           hover for that slice's duration, click to cut just it, red
 *                           strikethrough once cut
 */
import { useEffect, useRef, useState } from 'react'
import type { EDLSegment, TranscriptSegment, WordCut, WordMute } from '../../api/types'

// Mirrors the Timeline's pause markers in Editor.tsx — same threshold, same
// light/heavy visual split, so a pause reads as the same thing in both places.
const PAUSE_THRESHOLD = 0.4 // seconds

// faster-whisper's word timestamps aren't frame-accurate at boundaries, so a
// pause's detected [prevWord.end, nextWord.start] range can still contain a
// sliver of the adjacent words' actual audio. Cutting the full range flush
// clips them; leaving this much silence on each side instead is inaudible
// but keeps the cut safely inside the true gap. (Forced alignment, if
// enabled for the project, tightens word boundaries enough that this
// matters less — but the padding is cheap insurance either way.)
const PAUSE_CUT_PADDING = 0.1 // seconds

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

// ── Render item types ─────────────────────────────────────────────────────────

type RenderItem =
  | { kind: 'word'; w: FlatWord }
  | { kind: 'gap'; startTime: number; endTime: number; gapKey: string }
  | { kind: 'pause'; start: number; end: number; padStart: boolean; padEnd: boolean; pauseKey: string }

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  segments: TranscriptSegment[]
  wordCuts: WordCut[]
  wordMutes?: WordMute[]
  /** EDL segments from AI analysis — keep=false words are shown grayed + struck. */
  edlSegments?: EDLSegment[]
  /** Current video playback time — used to highlight the active word. */
  currentTime: number
  /**
   * When true, cut and EDL-cut words are hidden and gap chips replace cut runs
   * so the transcript reads as the final edited version.
   */
  cleanView?: boolean
  onSeek: (time: number) => void
  /** Called whenever the cut list changes (after delete or undo). */
  onCutsChange: (cuts: WordCut[]) => void
  onMutesChange: (mutes: WordMute[]) => void
  /** Called when the user presses Space — should toggle video play/pause. */
  onTogglePlay?: () => void
}

interface ToolbarState {
  x: number        // fixed screen x (center of toolbar)
  y: number        // fixed screen y (top of anchor word — toolbar renders above)
  selStart: number // global word index start of selection (-1 when pauseRange is set)
  selEnd: number   // global word index end of selection, inclusive (-1 when pauseRange is set)
  /** Set when the toolbar targets a pause slice instead of a word selection. */
  pauseRange?: { start: number; end: number; padStart: boolean; padEnd: boolean }
}

export default function TranscriptEditor({
  segments,
  wordCuts,
  wordMutes = [],
  edlSegments = [],
  currentTime,
  cleanView = false,
  onSeek,
  onCutsChange,
  onMutesChange,
  onTogglePlay,
}: Props) {
  const words = useRef<FlatWord[]>(flattenWords(segments))
  const [selRange, setSelRange] = useState<{ anchor: number; focus: number } | null>(null)
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null)
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastClickRef = useRef<{ idx: number; time: number }>({ idx: -1, time: 0 })

  useEffect(() => {
    words.current = flattenWords(segments)
  }, [segments])

  // ── Active word ───────────────────────────────────────────────────────────
  const activeIndex = words.current.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  )

  // Auto-scroll active word into view during playback
  useEffect(() => {
    if (activeIndex < 0) return
    const el = containerRef.current?.querySelector(`[data-gidx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIndex])

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

  function openPauseToolbar(el: HTMLElement, start: number, end: number, padStart: boolean, padEnd: boolean) {
    const rect = el.getBoundingClientRect()
    setToolbar({
      x: rect.left + rect.width / 2,
      y: rect.top,
      selStart: -1,
      selEnd: -1,
      pauseRange: { start, end, padStart, padEnd },
    })
    setSelRange(null)
  }

  function cutToolbarSelection() {
    if (!toolbar) return
    if (toolbar.pauseRange) {
      // Only pad the edge(s) of this slice that actually border real word
      // audio — an internal slice (part of a longer pause split into several
      // squiggles) borders other silence on both sides, so it can be cut flush.
      const { start, end, padStart, padEnd } = toolbar.pauseRange
      const paddedStart = padStart ? start + PAUSE_CUT_PADDING : start
      const paddedEnd = padEnd ? end - PAUSE_CUT_PADDING : end
      if (paddedEnd > paddedStart) {
        onCutsChange(mergeAndSort([...wordCuts, { start: paddedStart, end: paddedEnd }]))
      }
      setToolbar(null)
      return
    }
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
    if (toolbar.pauseRange) {
      const { start, end } = toolbar.pauseRange
      onCutsChange(wordCuts.filter((c) => c.end <= start || c.start >= end))
      setToolbar(null)
      return
    }
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

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (['INPUT', 'TEXTAREA', 'VIDEO', 'AUDIO'].includes(tag)) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (toolbar?.pauseRange) {
          e.preventDefault()
          cutToolbarSelection()
          return
        }
        if (selRange !== null) {
          e.preventDefault()
          const selected = words.current.filter((w) => isSelected(w.globalIndex))
          if (selected.length === 0) return
          const newCut: WordCut = { start: selected[0].start, end: selected[selected.length - 1].end }
          onCutsChange(mergeAndSort([...wordCuts, newCut]))
          setSelRange(null)
          setToolbar(null)
          return
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && wordCuts.length > 0) {
        e.preventDefault()
        onCutsChange(wordCuts.slice(0, -1))
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        onTogglePlay?.()
        return
      }
      if (e.key === 'Escape') {
        setToolbar(null)
        setSelRange(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selRange, toolbar, wordCuts, onCutsChange, onTogglePlay]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Close toolbar / selection on outside click ─────────────────────────────
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
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

  // ── Segment label click ────────────────────────────────────────────────────
  // Click  → select all words in the segment
  // Shift+click → extend current selection to encompass the whole segment
  function onSegmentLabelClick(e: React.MouseEvent, segIndex: number) {
    const segWords = words.current.filter((w) => w.segIndex === segIndex)
    if (segWords.length === 0) return
    e.preventDefault()
    setToolbar(null)
    const firstIdx = segWords[0].globalIndex
    const lastIdx  = segWords[segWords.length - 1].globalIndex

    if (e.shiftKey && selRange !== null) {
      // Extend from current anchor: if this segment is ahead, go to its last word;
      // if behind, go to its first word — so the full segment is always included.
      const focus = firstIdx > selRange.anchor ? lastIdx : firstIdx
      setSelRange({ anchor: selRange.anchor, focus })
      openToolbar(Math.min(selRange.anchor, focus), Math.max(selRange.anchor, focus))
    } else {
      setSelRange({ anchor: firstIdx, focus: lastIdx })
      openToolbar(firstIdx, lastIdx)
    }
  }

  function onWordPointerUp(_e: React.PointerEvent, idx: number, word: FlatWord) {
    isDragging.current = false
    const start = selRange ? Math.min(selRange.anchor, selRange.focus) : idx
    const end   = selRange ? Math.max(selRange.anchor, selRange.focus) : idx

    // Detect double-click: same word tapped twice within 400ms → select whole segment
    const now = Date.now()
    const isDoubleClick =
      lastClickRef.current.idx === idx &&
      now - lastClickRef.current.time < 400 &&
      start === end
    lastClickRef.current = { idx, time: now }

    if (isDoubleClick) {
      const segWords = words.current.filter((w) => w.segIndex === word.segIndex)
      if (segWords.length > 0) {
        const first = segWords[0].globalIndex
        const last  = segWords[segWords.length - 1].globalIndex
        setSelRange({ anchor: first, focus: last })
        openToolbar(first, last)
      }
      return
    }

    // Single click: seek video
    if (start === end) onSeek(word.start)
    openToolbar(start, end)
  }

  // ── Build render items ─────────────────────────────────────────────────────
  //
  // In normal view: all words are shown (cut words get strikethrough styling).
  // In clean view: cut words are hidden and replaced by gap chips; EDL-cut
  //   words are silently hidden (covered by the EDL panel in the sidebar).

  const grouped: { segIndex: number; label: string; items: RenderItem[] }[] = []
  let cutRunFirst: FlatWord | null = null
  let cutRunLast:  FlatWord | null = null
  // Last word actually rendered (in either view) — pause gaps are measured
  // against this, not the literal previous word, so a pause spanning hidden
  // cut/EDL-cut words in clean view still shows up before the next visible word.
  let lastRenderedWord: FlatWord | null = null

  function flushCutRun(group: { items: RenderItem[] }) {
    if (cutRunFirst && cutRunLast) {
      group.items.push({
        kind: 'gap',
        startTime: cutRunFirst.start,
        endTime: cutRunLast.end,
        gapKey: `gap-${cutRunFirst.globalIndex}`,
      })
    }
    cutRunFirst = null
    cutRunLast  = null
  }

  // Splits a pause into one squiggle per PAUSE_THRESHOLD-sized chunk (the
  // final chunk absorbs whatever remainder doesn't divide evenly), so a
  // longer pause reads as a run of individually clickable/cuttable squiggles
  // instead of one glyph representing the whole gap.
  function pushPauseIfNeeded(group: { items: RenderItem[] }, w: FlatWord) {
    if (!lastRenderedWord) return
    const gapStart = lastRenderedWord.end
    const gapEnd = w.start
    const dur = gapEnd - gapStart
    if (dur < PAUSE_THRESHOLD) return

    const count = Math.max(1, Math.floor(dur / PAUSE_THRESHOLD))
    for (let i = 0; i < count; i++) {
      const sliceStart = gapStart + i * PAUSE_THRESHOLD
      const sliceEnd = i === count - 1 ? gapEnd : sliceStart + PAUSE_THRESHOLD
      group.items.push({
        kind: 'pause',
        start: sliceStart,
        end: sliceEnd,
        padStart: i === 0,
        padEnd: i === count - 1,
        pauseKey: `pause-${w.globalIndex}-${i}`,
      })
    }
  }

  for (const w of words.current) {
    // Find or create the segment group
    let group = grouped[grouped.length - 1]
    if (!group || group.segIndex !== w.segIndex) {
      if (cleanView && group) flushCutRun(group)
      group = { segIndex: w.segIndex, label: segments[w.segIndex]?.speaker_name ?? '', items: [] }
      grouped.push(group)
    }

    const cut    = isCut(w, wordCuts)
    const edlCut = !cut && isEdlCut(w, edlSegments)

    if (cleanView) {
      if (cut) {
        // Accumulate into the running gap chip
        if (!cutRunFirst) cutRunFirst = w
        cutRunLast = w
      } else {
        flushCutRun(group)
        if (!edlCut) {
          pushPauseIfNeeded(group, w)
          group.items.push({ kind: 'word', w })
          lastRenderedWord = w
        }
      }
    } else {
      pushPauseIfNeeded(group, w)
      group.items.push({ kind: 'word', w })
      lastRenderedWord = w
    }
  }
  // Flush any trailing cut run in the last segment
  if (cleanView && grouped.length > 0) flushCutRun(grouped[grouped.length - 1])

  // ── Toolbar context ────────────────────────────────────────────────────────
  const toolbarWords = toolbar
    ? words.current.filter((w) => w.globalIndex >= toolbar.selStart && w.globalIndex <= toolbar.selEnd)
    : []
  const anyWordCut   = toolbarWords.some((w) => isCut(w, wordCuts))
  const allWordCut   = toolbarWords.length > 0 && toolbarWords.every((w) => isCut(w, wordCuts))
  const anyWordMuted = toolbarWords.some((w) => isMuted(w, wordMutes))
  const anchorEdlSeg = toolbarWords.length > 0 ? getEdlSegment(toolbarWords[0], edlSegments) : null
  const pauseAlreadyCut = toolbar?.pauseRange
    ? wordCuts.some((c) => c.start < toolbar.pauseRange!.end && c.end > toolbar.pauseRange!.start)
    : false

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
          {toolbar.pauseRange ? (
            pauseAlreadyCut
              ? <ToolbarBtn label="Restore" onClick={restoreToolbarSelection} color="#4db87a" />
              : <ToolbarBtn label="Cut pause" onClick={cutToolbarSelection} />
          ) : allWordCut ? (
            <ToolbarBtn label="Restore" onClick={restoreToolbarSelection} color="#4db87a" />
          ) : anyWordCut ? (
            <>
              <ToolbarBtn label="Cut" onClick={cutToolbarSelection} />
              <ToolbarBtn label="Restore" onClick={restoreToolbarSelection} color="#4db87a" />
            </>
          ) : (
            <ToolbarBtn label="Cut" onClick={cutToolbarSelection} />
          )}

          {/* Mute / Unmute — not applicable to a pause (there's nothing to mute) */}
          {!toolbar.pauseRange && (
            <>
              <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />
              {anyWordMuted
                ? <ToolbarBtn label="🔊 Unmute" onClick={unmuteToolbarSelection} />
                : <ToolbarBtn label="🔇 Mute" onClick={muteToolbarSelection} />
              }
            </>
          )}
        </div>
      )}

      {/* ── Transcript ───────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        tabIndex={0}
        style={{ outline: 'none', userSelect: 'none', WebkitUserSelect: 'none', lineHeight: 1.9, fontSize: 15 }}
      >
        {grouped.map((group) => {
          const segWords = words.current.filter((w) => w.segIndex === group.segIndex)
          const segSelected = segWords.length > 0
            && isSelected(segWords[0].globalIndex)
            && isSelected(segWords[segWords.length - 1].globalIndex)
          return (
          <div key={group.segIndex} style={{ marginBottom: 16 }}>
            <div
              onClick={(e) => onSegmentLabelClick(e, group.segIndex)}
              title="Click to select segment · Shift+click to extend selection"
              style={{
                fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                marginBottom: 4,
                color: segSelected ? '#fff' : 'var(--accent)',
                background: segSelected ? 'rgba(59,130,246,0.35)' : 'transparent',
                borderRadius: 3, padding: '1px 4px', marginLeft: -4,
                cursor: 'pointer', display: 'inline-block',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => { if (!segSelected) (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.15)' }}
              onMouseLeave={(e) => { if (!segSelected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              {group.label}
            </div>
            <div>
              {group.items.map((item) => {
                if (item.kind === 'pause') {
                  const isPauseSelected = toolbar?.pauseRange?.start === item.start && toolbar?.pauseRange?.end === item.end
                  const isPauseCut = wordCuts.some((c) => c.start < item.end && c.end > item.start)
                  const sliceDur = item.end - item.start
                  return (
                    <span
                      key={item.pauseKey}
                      title={isPauseCut ? `${sliceDur.toFixed(2)}s of pause — cut (click to restore)` : `${sliceDur.toFixed(2)}s of pause — click to cut`}
                      onClick={(e) => {
                        e.stopPropagation()
                        openPauseToolbar(e.currentTarget, item.start, item.end, item.padStart, item.padEnd)
                      }}
                      style={{
                        display: 'inline-block',
                        marginRight: 4,
                        padding: '0 3px',
                        borderRadius: 3,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        color: isPauseCut ? '#e05555' : 'var(--text-muted)',
                        opacity: isPauseCut ? 0.6 : 0.55,
                        textDecoration: isPauseCut ? 'line-through' : 'none',
                        background: isPauseSelected ? 'rgba(59,130,246,0.35)' : 'transparent',
                        verticalAlign: 'middle',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                      onMouseEnter={(e) => { if (!isPauseSelected) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)' }}
                      onMouseLeave={(e) => { if (!isPauseSelected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                    >
                      〜
                    </span>
                  )
                }

                if (item.kind === 'gap') {
                  const dur = item.endTime - item.startTime
                  return (
                    <span
                      key={item.gapKey}
                      title={`${dur.toFixed(2)}s removed`}
                      style={{
                        display: 'inline-flex', alignItems: 'center',
                        background: 'rgba(229,51,51,0.12)',
                        border: '1px solid rgba(229,51,51,0.35)',
                        borderRadius: 3,
                        padding: '0 5px', marginRight: 4,
                        fontSize: 11, color: '#e05555',
                        fontFamily: 'monospace',
                        verticalAlign: 'middle',
                        cursor: 'default',
                      }}
                    >
                      [{dur.toFixed(1)}s]
                    </span>
                  )
                }

                const { w } = item
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
          )
        })}

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

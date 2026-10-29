/**
 * Editor timeline: a time ruler, a lane of phrase and pause chips, and the
 * waveform with EDL shading and cuts, with zoom/pan and drag-to-select cutting.
 * Click a chip to select it (Shift+click or drag along the lane to select
 * several), then Delete or Cut removes it. Split (or S) breaks the chip under
 * the playhead in two, for custom chunks; click a split's ruler marker to remove it. Pause chips can be dragged shorter
 * (or back out to their recorded length), which writes a manual cut inside the
 * gap. Times are in source seconds.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { EDLSegment, TranscriptSegment, WordCut } from '../../api/types'
import { formatTimecode } from '../../formatTime'
import { mergeAndSortCuts, subtractRange } from './timeMap'

const PAUSE_MIN = 0.3        // seconds — shorter gaps stay inside a phrase chip
const PAUSE_LABEL_MIN = 0.8  // seconds — longer pauses show their length, shorter show ···
const PAUSE_TAIL = 0.08      // seconds — kept just before the next word when shortening a pause
const PAUSE_SNAP = 0.05      // seconds — pause drag step
const MIN_VISIBLE = 3        // seconds — most zoomed-in view
const READABLE_PX_PER_SEC = 45 // px per second at 100% zoom — phrase chips are readable
const WAVEFORM_RATE = 40     // waveform values per second of audio
const BAR_PX = 2             // px per waveform bar
const CHIP_MIN_PX = 6        // narrower chips are hidden
const SPLIT_EDGE = 0.02      // seconds — splits closer than this to a chunk edge are ignored
const NOISE_HEADROOM_DB = 4  // the waveform floor sits this far above the background noise
const DRAG_PX_THRESHOLD = 4  // pixels — less than this is a click, not a drag
const SCROLLBAR_H = 7        // px — height of the scrollbar strip
const RULER_H = 18           // px
const LANE_TOP = RULER_H + 3 // px — top of the word lane
const LANE_H = 22            // px
const WAVE_TOP = LANE_TOP + LANE_H + 4
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]

type DragMode = 'none' | 'selecting' | 'chunks' | 'left-handle' | 'right-handle' | 'scrollbar' | 'pause'

type Phrase = { start: number; end: number; text: string; cut: boolean }
/** A silence between words; `kept` is how much of it survives the cuts. */
type Pause = { start: number; end: number; kept: number; locked: boolean }
/** A chip in the word lane — a phrase or a pause. */
type Chunk = { start: number; end: number }

/** Ruler label: m:ss, with tenths when ticks are under a second apart. */
function formatTick(t: number, step: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0')
  return `${m}:${ss}`
}

/** Seconds of [start, end] covered by the (merged, non-overlapping) cuts. */
function cutLength(cuts: WordCut[], start: number, end: number): number {
  return cuts.reduce((sum, c) => sum + Math.max(0, Math.min(end, c.end) - Math.max(start, c.start)), 0)
}

export default function Timeline({
  height,
  duration,
  currentTime,
  outputDuration,
  outputCurrentTime,
  wordCuts,
  edlSegments,
  segments,
  projectId,
  speakerFile,
  onSeek,
  onCutsChange,
  splits,
  onSplitsChange,
}: {
  /** Panel height in px, including the controls row. */
  height: number
  duration: number
  currentTime: number
  outputDuration: number
  outputCurrentTime: number
  wordCuts: WordCut[]
  edlSegments: EDLSegment[]
  segments: TranscriptSegment[]
  projectId: string
  speakerFile: string | undefined
  onSeek: (t: number) => void
  onCutsChange: (cuts: WordCut[]) => void
  /** Source times where the user split chunks. */
  splits: number[]
  onSplitsChange: (splits: number[]) => void
}) {
  const [waveform, setWaveform] = useState<number[]>([])
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [pauseDrag, setPauseDrag] = useState<{ pause: Pause; kept: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [trackWidth, setTrackWidth] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragMode = useRef<DragMode>('none')
  const dragAnchorTime = useRef(0)
  const dragStartX = useRef(0)
  const chunkAnchorEnd = useRef(0) // end of the chunk a chunk drag started on
  // Refs so the non-passive wheel handler always reads fresh values
  const zoomRef = useRef(1)
  const viewStartRef = useRef(0)
  const durationRef = useRef(duration)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])
  useEffect(() => { durationRef.current = duration }, [duration])

  const maxZoom = Math.max(1, duration / MIN_VISIBLE)

  // Fetch waveform once the file and duration are known
  useEffect(() => {
    if (!speakerFile || duration === 0) return
    const buckets = Math.min(200_000, Math.max(400, Math.ceil(duration * WAVEFORM_RATE)))
    api.getWaveform(projectId, speakerFile, buckets).then(({ waveform }) => setWaveform(waveform)).catch(() => {})
  }, [projectId, speakerFile, duration])

  // Bar heights on a dB scale whose floor sits just above the background noise
  // (the quietest tenth of the file), so silence draws flat and speech fills the lane
  const barHeights = useMemo(() => {
    if (waveform.length === 0) return []
    const sorted = [...waveform].sort((a, b) => a - b)
    const noise = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.1)])
    const floorDb = Math.min(-20, Math.max(-60, 20 * Math.log10(noise) + NOISE_HEADROOM_DB))
    return waveform.map((amp) => Math.max(0, Math.min(1, 1 - (20 * Math.log10(Math.max(amp, 1e-6))) / floorDb)))
  }, [waveform])

  // Track width in pixels, for ruler spacing and hiding chips too small to read
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setTrackWidth(el.clientWidth))
    observer.observe(el)
    setTrackWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  // ── Zoom / pan ───────────────────────────────────────────────────────────────
  const visibleDuration = duration > 0 ? duration / zoom : 0
  const pxPerSec = visibleDuration > 0 ? trackWidth / visibleDuration : 0
  // `zoom` is a multiple of the fit-to-width view; the readable scale is what's shown as 100%
  const readableZoom = trackWidth > 0 && duration > 0
    ? Math.max(1, Math.min(maxZoom, (READABLE_PX_PER_SEC * duration) / trackWidth))
    : 1
  const zoomPercent = Math.max(1, Math.round((pxPerSec / READABLE_PX_PER_SEC) * 100))

  // Open at the readable scale once the recording length and track width are known
  const zoomInitialised = useRef(false)
  useEffect(() => {
    if (zoomInitialised.current || duration === 0 || trackWidth === 0) return
    zoomInitialised.current = true
    setZoom(readableZoom)
  }, [duration, trackWidth, readableZoom])

  // Clamp viewStart when zoom or source duration changes
  useEffect(() => {
    if (duration === 0) return
    setViewStart((vs) => Math.min(vs, Math.max(0, duration - duration / zoom)))
  }, [zoom, duration])

  // Auto-scroll to follow the playhead when zoomed in
  useEffect(() => {
    const z = zoomRef.current
    const dur = durationRef.current
    if (z <= 1 || dur === 0) return
    const visD = dur / z
    const vs = viewStartRef.current
    if (currentTime < vs || currentTime > vs + visD) {
      setViewStart(Math.max(0, Math.min(dur - visD, currentTime - visD * 0.1)))
    }
  }, [currentTime])

  // Non-passive wheel listener — zooms centered on mouse cursor
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const dur = durationRef.current
      if (dur === 0) return
      const z = zoomRef.current
      const vs = viewStartRef.current
      const rect = el.getBoundingClientRect()
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const visD = dur / z
      const mouseTime = vs + mouseRatio * visD
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25
      const newZoom = Math.max(1, Math.min(Math.max(1, dur / MIN_VISIBLE), z * factor))
      if (newZoom === z) return
      const newVisD = dur / newZoom
      setZoom(newZoom)
      setViewStart(Math.max(0, Math.min(dur - newVisD, mouseTime - mouseRatio * newVisD)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  function applyZoom(newZoom: number) {
    if (duration === 0) return
    newZoom = Math.max(1, Math.min(maxZoom, newZoom))
    const newVisD = duration / newZoom
    setZoom(newZoom)
    if (newZoom <= 1) {
      setViewStart(0)
    } else {
      setViewStart(Math.max(0, Math.min(duration - newVisD, currentTime - newVisD / 2)))
    }
  }

  // Position helpers — all times are in source seconds, mapped to visible window
  const toLeft = (time: number) =>
    visibleDuration > 0 ? `${((time - viewStart) / visibleDuration) * 100}%` : '0%'
  const toWidth = (dt: number) =>
    visibleDuration > 0 ? `${(dt / visibleDuration) * 100}%` : '0%'
  const inView = (s: number, e: number) =>
    e > viewStart && s < viewStart + visibleDuration

  // ── Phrases and pauses ───────────────────────────────────────────────────────
  // Words closer than PAUSE_MIN form one phrase chip; longer gaps (including
  // leading and trailing silence) become pause chips. User splits then break
  // any chip in two at the split time.
  const { phrases, pauses } = useMemo(() => {
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
  }, [segments, wordCuts, edlSegments, duration, splits])

  /** Split the chunk under the playhead at the playhead. */
  function splitAtPlayhead() {
    const t = Math.round(currentTime * 1000) / 1000
    const chunk = chunks.find((c) => t > c.start + SPLIT_EDGE && t < c.end - SPLIT_EDGE)
    if (!chunk || splits.some((s) => Math.abs(s - t) < SPLIT_EDGE)) return
    onSplitsChange([...splits, t].sort((a, b) => a - b))
  }

  const chunks: Chunk[] = useMemo(
    () => [...phrases, ...pauses].sort((a, b) => a.start - b.start),
    [phrases, pauses],
  )

  /** The chunk under time t, or the nearest one. */
  function chunkAt(t: number): Chunk | null {
    let best: Chunk | null = null
    let bestDist = Infinity
    for (const c of chunks) {
      const dist = t < c.start ? c.start - t : t > c.end ? t - c.end : 0
      if (dist < bestDist) { best = c; bestDist = dist }
      if (dist === 0) break
    }
    return best
  }

  const isSelected = (c: Chunk) =>
    !!selection && c.start >= selection.start - 0.001 && c.end <= selection.end + 0.001

  /** Keep `kept` seconds of a pause: cut its middle, leaving a short tail before the next word. */
  function setPauseLength(pause: Pause, kept: number) {
    let cuts = subtractRange(wordCuts, pause.start, pause.end)
    if (pause.end - pause.start - kept > 0.02) {
      const tail = Math.min(PAUSE_TAIL, kept / 2)
      cuts = [...cuts, { start: pause.start + kept - tail, end: pause.end - tail }]
    }
    onCutsChange(mergeAndSortCuts(cuts))
  }

  // Ruler ticks — the smallest step that leaves room for a label
  const tickStep = TICK_STEPS.find((s) => s * pxPerSec >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const ticks: number[] = []
  if (pxPerSec > 0) {
    const last = Math.floor((viewStart + visibleDuration) / tickStep)
    for (let k = Math.ceil(viewStart / tickStep); k <= last; k++) ticks.push(k * tickStep)
  }

  // Delete/Escape keyboard handling when there's an active selection
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selection) return
      const tag = (e.target as HTMLElement).tagName
      if (['INPUT', 'TEXTAREA', 'VIDEO', 'AUDIO'].includes(tag)) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        commitCut()
      }
      if (e.key === 'Escape') setSelection(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selection, wordCuts]) // eslint-disable-line react-hooks/exhaustive-deps

  // S splits the chunk under the playhead
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 's' || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable) return
      e.preventDefault()
      splitAtPlayhead()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentTime, chunks, splits]) // eslint-disable-line react-hooks/exhaustive-deps

  // Maps screen x → source time, accounting for zoom/pan
  function pxToTime(clientX: number): number {
    if (!trackRef.current || duration === 0) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.max(0, Math.min(duration, viewStart + ratio * visibleDuration))
  }

  function commitCut() {
    if (!selection || selection.end - selection.start < 0.033) {
      setSelection(null)
      return
    }
    onCutsChange(mergeAndSortCuts([...wordCuts, { start: selection.start, end: selection.end }]))
    setSelection(null)
  }

  /** Remove any manual cuts inside the selection. */
  function restoreSelection() {
    if (!selection) return
    onCutsChange(subtractRange(wordCuts, selection.start, selection.end))
    setSelection(null)
  }

  // ── Pointer handlers ──────────────────────────────────────────────────────
  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (duration === 0) return
    if ((e.target as HTMLElement).dataset.handle) return
    e.preventDefault()

    // Bottom strip = scrollbar zone (only when zoomed)
    if (zoom > 1 && trackRef.current) {
      const rect = trackRef.current.getBoundingClientRect()
      if (e.clientY > rect.bottom - SCROLLBAR_H - 2) {
        // Click on scrollbar — jump view to clicked position then start drag
        const ratio = (e.clientX - rect.left) / rect.width
        const clickTime = ratio * duration
        const maxVs = duration - visibleDuration
        const newVs = Math.max(0, Math.min(maxVs, clickTime - visibleDuration / 2))
        setViewStart(newVs)
        dragMode.current = 'scrollbar'
        dragStartX.current = e.clientX
        dragAnchorTime.current = newVs
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
    }

    dragStartX.current = e.clientX
    const t = pxToTime(e.clientX)
    dragAnchorTime.current = t
    dragMode.current = 'selecting'
    setSelection({ start: t, end: t })
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (dragMode.current === 'none' || duration === 0) return
    if (dragMode.current === 'scrollbar') {
      if (!trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const dx = e.clientX - dragStartX.current
      const dtPerPx = duration / rect.width
      const maxVs = duration - visibleDuration
      setViewStart(Math.max(0, Math.min(maxVs, dragAnchorTime.current + dx * dtPerPx)))
      return
    }
    const t = pxToTime(e.clientX)
    if (dragMode.current === 'chunks') {
      const c = chunkAt(t)
      if (c) setSelection({ start: Math.min(dragAnchorTime.current, c.start), end: Math.max(chunkAnchorEnd.current, c.end) })
    } else if (dragMode.current === 'pause' && pauseDrag) {
      const { pause } = pauseDrag
      const kept = Math.round((t - pause.start) / PAUSE_SNAP) * PAUSE_SNAP
      setPauseDrag({ pause, kept: Math.max(0, Math.min(pause.end - pause.start, kept)) })
    } else if (dragMode.current === 'selecting') {
      setSelection({ start: Math.min(dragAnchorTime.current, t), end: Math.max(dragAnchorTime.current, t) })
    } else if (dragMode.current === 'left-handle' && selection) {
      setSelection({ start: Math.min(t, selection.end - 0.033), end: selection.end })
    } else if (dragMode.current === 'right-handle' && selection) {
      setSelection({ start: selection.start, end: Math.max(t, selection.start + 0.033) })
    }
  }

  function onTrackPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (dragMode.current === 'none') return
    const wasDrag = Math.abs(e.clientX - dragStartX.current) >= DRAG_PX_THRESHOLD
    if (dragMode.current === 'pause') {
      if (pauseDrag && Math.abs(pauseDrag.kept - pauseDrag.pause.kept) > 0.01) {
        setPauseLength(pauseDrag.pause, pauseDrag.kept)
      }
      setPauseDrag(null)
    } else if (dragMode.current === 'chunks' && !wasDrag) {
      onSeek(dragAnchorTime.current)
    } else if (dragMode.current === 'selecting' && !wasDrag) {
      onSeek(pxToTime(e.clientX))
      setSelection(null)
    }
    dragMode.current = 'none'
  }

  // ── Handle pointer events (resize left/right edge of selection) ────────────
  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>, side: 'left' | 'right') {
    e.stopPropagation()
    e.preventDefault()
    if (!selection) return
    dragMode.current = side === 'left' ? 'left-handle' : 'right-handle'
    dragAnchorTime.current = side === 'left' ? selection.end : selection.start
    // Capture on the track so move/up fire there
    trackRef.current?.setPointerCapture(e.pointerId)
  }

  // ── Chunk pointer events (click, Shift+click or drag along the word lane) ──
  function onChunkPointerDown(e: React.PointerEvent<HTMLDivElement>, chunk: Chunk) {
    e.stopPropagation()
    e.preventDefault()
    if (e.shiftKey && selection) {
      setSelection({ start: Math.min(selection.start, chunk.start), end: Math.max(selection.end, chunk.end) })
      return
    }
    dragMode.current = 'chunks'
    dragStartX.current = e.clientX
    dragAnchorTime.current = chunk.start
    chunkAnchorEnd.current = chunk.end
    setSelection({ start: chunk.start, end: chunk.end })
    trackRef.current?.setPointerCapture(e.pointerId)
  }

  function onPauseHandlePointerDown(e: React.PointerEvent<HTMLDivElement>, pause: Pause) {
    e.stopPropagation()
    e.preventDefault()
    setSelection(null)
    dragMode.current = 'pause'
    dragStartX.current = e.clientX
    setPauseDrag({ pause, kept: pause.kept })
    trackRef.current?.setPointerCapture(e.pointerId)
  }

  // Selection position in visible-window percentages (for overlay + toolbar)
  const selPct = selection && visibleDuration > 0
    ? {
        left: ((selection.start - viewStart) / visibleDuration) * 100,
        width: ((selection.end - selection.start) / visibleDuration) * 100,
      }
    : null

  // Scrollbar thumb geometry
  const scrollLeft = duration > 0 ? (viewStart / duration) * 100 : 0
  const scrollWidth = (1 / zoom) * 100

  const selectedChip: React.CSSProperties = {
    background: 'rgba(59,130,246,0.3)', border: '1px solid rgba(59,130,246,0.9)',
  }
  // Whether the selection includes anything already cut, so it can be restored
  const selectionHasCuts = !!selection && wordCuts.some((c) => c.start < selection.end && c.end > selection.start)

  const chipBase: React.CSSProperties = {
    position: 'absolute', top: LANE_TOP, height: LANE_H,
    borderRadius: 4, fontSize: 11, lineHeight: `${LANE_H}px`,
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    boxSizing: 'border-box', pointerEvents: 'none',
  }

  return (
    <div style={{
      height, flexShrink: 0,
      background: 'var(--bg-elevated)',
      borderTop: '1px solid var(--border)',
      padding: '8px 16px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {/* Labels row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {/* Time display */}
        <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'monospace' }}>
          {pauseDrag
            ? `Pause ${pauseDrag.kept.toFixed(2)}s of ${(pauseDrag.pause.end - pauseDrag.pause.start).toFixed(2)}s`
            : selection
              ? `${formatTimecode(selection.start)} → ${formatTimecode(selection.end)}  (${(selection.end - selection.start).toFixed(2)}s)`
              : outputDuration > 0
                ? <>
                    {formatTimecode(outputCurrentTime)}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {` / ${formatTimecode(outputDuration)}${outputDuration < duration ? ` · ${formatTimecode(duration - outputDuration)} cut` : ''}`}
                    </span>
                  </>
                : '--:-- / --:--'
          }
        </span>

        {/* Split at playhead */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={splitAtPlayhead}
          disabled={duration === 0}
          title="Split the chunk under the playhead (S)"
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', fontSize: 12, padding: '2px 10px', cursor: 'pointer' }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
            <rect x="0.65" y="2.65" width="4" height="6.7" rx="1" />
            <rect x="7.35" y="2.65" width="4" height="6.7" rx="1" />
            <path d="M6 0.5v11" strokeDasharray="1.5 1.2" />
          </svg>
          Split
        </button>

        {/* Zoom controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => applyZoom(zoom / 1.5)}
            disabled={zoom <= 1}
            title="Zoom out"
            style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: 16, lineHeight: 1, padding: '0 4px', cursor: zoom <= 1 ? 'default' : 'pointer', opacity: zoom <= 1 ? 0.35 : 1 }}
          >−</button>
          <span
            style={{ fontSize: 12, color: 'var(--text)', minWidth: 44, textAlign: 'center', cursor: readableZoom > 1 ? 'pointer' : 'default' }}
            title={readableZoom > 1 ? (zoom > 1 ? 'Click to fit the whole recording' : 'Click to zoom to 100%') : undefined}
            onClick={readableZoom > 1 ? () => applyZoom(zoom > 1 ? 1 : readableZoom) : undefined}
          >
            {zoomPercent}%
          </span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => applyZoom(zoom * 1.5)}
            disabled={zoom >= maxZoom}
            title="Zoom in"
            style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: 16, lineHeight: 1, padding: '0 4px', cursor: zoom >= maxZoom ? 'default' : 'pointer', opacity: zoom >= maxZoom ? 0.35 : 1 }}
          >+</button>
        </div>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        style={{
          flex: 1, position: 'relative',
          borderRadius: 4, overflow: 'visible',
          cursor: duration > 0 ? 'crosshair' : 'default',
          userSelect: 'none',
        }}
      >
        {/* Inner clip — leaves room for the scrollbar at the bottom when zoomed */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          bottom: zoom > 1 ? SCROLLBAR_H + 1 : 0,
          overflow: 'hidden',
        }}>
          {duration > 0 ? (
            <>
              {/* Ruler */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: RULER_H, borderBottom: '1px solid var(--border)' }}>
                {ticks.map((t) => (
                  <div key={t} style={{ position: 'absolute', left: toLeft(t), top: 0, bottom: 0, pointerEvents: 'none' }}>
                    <div style={{ position: 'absolute', left: 0, bottom: 0, width: 1, height: 4, background: 'var(--text-muted)' }} />
                    <span style={{ position: 'absolute', left: 0, top: 0, transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {formatTick(t, tickStep)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Waveform lane background */}
              <div style={{ position: 'absolute', top: WAVE_TOP, left: 0, right: 0, bottom: 0, background: 'var(--bg-card)', borderRadius: 4 }} />

              {/* EDL segment shading */}
              {edlSegments.filter((s) => inView(s.start, s.end)).map((seg) => (
                <div
                  key={seg.id}
                  style={{
                    position: 'absolute', top: WAVE_TOP, bottom: 0,
                    left: toLeft(seg.start), width: toWidth(seg.end - seg.start),
                    background: seg.keep ? 'rgba(50,180,100,0.08)' : 'rgba(200,50,50,0.16)',
                  }}
                />
              ))}

              {/* Waveform — the visible portion, reduced to one bar per BAR_PX (max of each run) */}
              {waveform.length > 0 && (() => {
                const startIdx = Math.floor((viewStart / duration) * waveform.length)
                const endIdx = Math.ceil(((viewStart + visibleDuration) / duration) * waveform.length)
                const visible = barHeights.slice(startIdx, endIdx)
                const per = Math.max(1, Math.floor(visible.length / Math.max(1, trackWidth / BAR_PX)))
                const slice: number[] = []
                for (let i = 0; i < visible.length; i += per) slice.push(Math.max(...visible.slice(i, i + per)))
                // Place the slice by its buckets' own times so bars line up with the words
                const bucketDur = duration / waveform.length
                return (
                  <svg
                    style={{ position: 'absolute', top: WAVE_TOP, left: toLeft(startIdx * bucketDur), width: toWidth(slice.length * per * bucketDur), height: `calc(100% - ${WAVE_TOP}px)`, pointerEvents: 'none', fill: 'var(--text)', fillOpacity: 0.6 }}
                    viewBox={`0 0 ${slice.length} 100`}
                    preserveAspectRatio="none"
                  >
                    {slice.map((amp, i) => {
                      const h = Math.max(0.6, amp * 94)
                      return <rect key={i} x={i} y={(100 - h) / 2} width={0.75} height={h} />
                    })}
                  </svg>
                )
              })()}

              {/* Phrase chips */}
              {phrases.filter((p) => inView(p.start, p.end) && (p.end - p.start) * pxPerSec >= CHIP_MIN_PX).map((p) => (
                <div
                  key={`w${p.start}`}
                  title={p.text}
                  onPointerDown={(e) => onChunkPointerDown(e, p)}
                  style={{
                    ...chipBase,
                    left: toLeft(p.start), width: toWidth(p.end - p.start),
                    padding: (p.end - p.start) * pxPerSec >= 20 ? '0 6px' : 0,
                    pointerEvents: 'auto', cursor: 'pointer',
                    ...(isSelected(p) ? selectedChip : { background: 'var(--bg-card)', border: '1px solid var(--border)' }),
                    color: p.cut ? 'var(--text-muted)' : 'var(--text)',
                    textDecoration: p.cut ? 'line-through' : 'none',
                    opacity: p.cut ? 0.5 : 1,
                  }}
                >
                  {(p.end - p.start) * pxPerSec >= 20 ? p.text : ''}
                </div>
              ))}

              {/* Pause chips — the solid part is what's kept, the outline is the recorded length */}
              {pauses.filter((p) => inView(p.start, p.end) && (p.end - p.start) * pxPerSec >= CHIP_MIN_PX).map((p) => {
                const dragging = pauseDrag && pauseDrag.pause.start === p.start
                const kept = dragging ? pauseDrag.kept : p.kept
                const full = p.end - p.start
                const keptPx = kept * pxPerSec
                const label = full >= PAUSE_LABEL_MIN || dragging ? `${kept.toFixed(1)}s` : '···'
                return (
                  <div key={`p${p.start}`}>
                    <div style={{
                      ...chipBase,
                      left: toLeft(p.start), width: toWidth(full),
                      border: '1px dashed var(--border)',
                      opacity: kept < full - 0.01 || p.locked ? 1 : 0,
                    }} />
                    {!p.locked && (
                      <>
                        <div
                          onPointerDown={(e) => onChunkPointerDown(e, p)}
                          style={{
                            ...chipBase,
                            left: toLeft(p.start), width: toWidth(kept),
                            ...(dragging || isSelected(p) ? selectedChip : { background: 'var(--bg-card)', border: '1px solid var(--border)' }),
                            pointerEvents: 'auto', cursor: 'pointer',
                            color: 'var(--text-muted)', textAlign: 'center',
                            display: kept > 0 ? 'block' : 'none',
                          }}
                        >
                          {keptPx >= 22 ? label : ''}
                        </div>
                        <div
                          data-handle="pause"
                          onPointerDown={(e) => onPauseHandlePointerDown(e, p)}
                          title={`${kept.toFixed(2)}s pause (recorded ${full.toFixed(2)}s) — drag to shorten or lengthen`}
                          style={{
                            position: 'absolute', top: LANE_TOP, height: LANE_H,
                            left: toLeft(p.start + kept), width: 8, transform: 'translateX(-50%)',
                            cursor: 'ew-resize', zIndex: 3,
                            display: 'flex', justifyContent: 'center',
                          }}
                        >
                          <div style={{ width: 2, margin: '4px 0', borderRadius: 1, background: dragging ? 'rgba(59,130,246,0.9)' : 'var(--text-muted)', opacity: dragging ? 1 : 0.6 }} />
                        </div>
                      </>
                    )}
                  </div>
                )
              })}

              {/* Committed cuts */}
              {wordCuts.filter((c) => inView(c.start, c.end)).map((cut, i) => (
                <div
                  key={i}
                  style={{
                    position: 'absolute', top: WAVE_TOP, bottom: 0,
                    left: toLeft(cut.start),
                    width: toWidth(Math.max(0.033, cut.end - cut.start)),
                    background: 'repeating-linear-gradient(135deg, rgba(229,51,51,0.45) 0 4px, rgba(229,51,51,0.2) 4px 8px)',
                    borderLeft: '1px solid rgba(229,51,51,0.9)', borderRight: '1px solid rgba(229,51,51,0.9)',
                    pointerEvents: 'none',
                  }}
                />
              ))}

              {/* Split markers — dashed line through the lanes, ruler tab removes the split */}
              {splits.filter((t) => inView(t, t)).map((t) => (
                <div key={`s${t}`}>
                  <div style={{ position: 'absolute', top: LANE_TOP, bottom: 0, left: toLeft(t), width: 0, borderLeft: '1px dashed rgba(250,204,21,0.8)', pointerEvents: 'none', zIndex: 2 }} />
                  <div
                    data-handle="split"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onSplitsChange(splits.filter((x) => x !== t))}
                    title={`Split at ${formatTimecode(t)} — click to remove`}
                    style={{
                      position: 'absolute', top: 2, left: toLeft(t), transform: 'translateX(-50%)',
                      width: 10, height: RULER_H - 4, borderRadius: 2,
                      background: 'rgb(250,204,21)', cursor: 'pointer', zIndex: 5,
                    }}
                  />
                </div>
              ))}

              {/* Playhead */}
              {inView(currentTime - 0.1, currentTime + 0.1) && (
                <div
                  style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: toLeft(currentTime),
                    width: 1.5, background: 'var(--text)',
                    transform: 'translateX(-50%)',
                    pointerEvents: 'none', zIndex: 4,
                  }}
                >
                  <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 9, height: 9, background: 'var(--text)', clipPath: 'polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)' }} />
                </div>
              )}

              {/* Active selection overlay */}
              {selPct && selPct.width > 0 && (
                <>
                  <div style={{ position: 'absolute', top: LANE_TOP, bottom: 0, left: `${selPct.left}%`, width: `${selPct.width}%`, background: 'rgba(59,130,246,0.28)', pointerEvents: 'none' }} />
                  <div data-handle="left" onPointerDown={(e) => onHandlePointerDown(e, 'left')} style={{ position: 'absolute', top: LANE_TOP, bottom: 0, width: 6, left: `${selPct.left}%`, transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.9)', cursor: 'ew-resize', zIndex: 5, borderRadius: '2px 0 0 2px' }} />
                  <div data-handle="right" onPointerDown={(e) => onHandlePointerDown(e, 'right')} style={{ position: 'absolute', top: LANE_TOP, bottom: 0, width: 6, left: `${selPct.left + selPct.width}%`, transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.9)', cursor: 'ew-resize', zIndex: 5, borderRadius: '0 2px 2px 0' }} />
                </>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 12 }}>
              Load a file to see the timeline
            </div>
          )}
        </div>

        {/* Scrollbar — only visible when zoomed in */}
        {zoom > 1 && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            height: SCROLLBAR_H,
            background: 'rgba(0,0,0,0.35)',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', top: 1, bottom: 1,
              left: `${scrollLeft}%`,
              width: `${scrollWidth}%`,
              background: 'rgba(255,255,255,0.3)',
              borderRadius: 3,
              minWidth: 12,
            }} />
          </div>
        )}

        {/* Selection toolbar — floats above the track */}
        {selPct && selPct.width > 0.3 && selection && (
          <div
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              left: `${Math.max(5, Math.min(95, selPct.left + selPct.width / 2))}%`,
              transform: 'translateX(-50%)',
              zIndex: 100,
              display: 'flex', alignItems: 'center', gap: 1,
              background: '#1c1c1c', border: '1px solid #3a3a3a',
              borderRadius: 7, padding: '3px 4px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              fontSize: 12, whiteSpace: 'nowrap',
            }}
          >
            <button onPointerDown={(e) => e.stopPropagation()} onClick={commitCut} style={{ background: 'none', border: 'none', color: '#e05555', padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2e2e2e' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
              ✂ Cut {(selection.end - selection.start).toFixed(2)}s
            </button>
            {selectionHasCuts && (
              <button onPointerDown={(e) => e.stopPropagation()} onClick={restoreSelection} style={{ background: 'none', border: 'none', color: '#5cbf7a', padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2e2e2e' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
                ↺ Restore
              </button>
            )}
            <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setSelection(null)} style={{ background: 'none', border: 'none', color: '#888', padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2e2e2e' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

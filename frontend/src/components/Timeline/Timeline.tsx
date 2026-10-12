/**
 * Editor timeline: waveform, EDL shading, pauses and cuts, with zoom/pan and
 * drag-to-select cutting. Times are in source seconds.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { EDLSegment, TranscriptSegment, WordCut } from '../../api/types'
import { formatTimecode } from '../../formatTime'
import { mergeAndSortCuts } from './timeMap'

const PAUSE_THRESHOLD = 0.4 // seconds
const DRAG_PX_THRESHOLD = 4  // pixels — less than this is a click, not a drag
const SCROLLBAR_H = 7        // px — height of the scrollbar strip

type DragMode = 'none' | 'selecting' | 'left-handle' | 'right-handle' | 'scrollbar'

export default function Timeline({
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
}: {
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
}) {
  const [waveform, setWaveform] = useState<number[]>([])
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragMode = useRef<DragMode>('none')
  const dragAnchorTime = useRef(0)
  const dragStartX = useRef(0)
  // Refs so the non-passive wheel handler always reads fresh values
  const zoomRef = useRef(1)
  const viewStartRef = useRef(0)
  const durationRef = useRef(duration)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])
  useEffect(() => { durationRef.current = duration }, [duration])

  // Fetch waveform once the file and duration are known
  useEffect(() => {
    if (!speakerFile || duration === 0) return
    api.getWaveform(projectId, speakerFile).then(({ waveform }) => setWaveform(waveform)).catch(() => {})
  }, [projectId, speakerFile, duration])

  // ── Zoom / pan ───────────────────────────────────────────────────────────────
  const visibleDuration = duration > 0 ? duration / zoom : 0

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
      const newZoom = Math.max(1, Math.min(100, z * factor))
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
    newZoom = Math.max(1, Math.min(100, newZoom))
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

  // Detect pauses
  const pauses = useMemo(() => {
    const result: Array<{ time: number; dur: number }> = []
    for (const seg of segments) {
      for (let i = 0; i < seg.words.length - 1; i++) {
        const gap = seg.words[i + 1].start - seg.words[i].end
        if (gap >= PAUSE_THRESHOLD) result.push({ time: seg.words[i].end + gap / 2, dur: gap })
      }
    }
    for (let i = 0; i < segments.length - 1; i++) {
      const gap = segments[i + 1].start - segments[i].end
      if (gap >= PAUSE_THRESHOLD) result.push({ time: segments[i].end + gap / 2, dur: gap })
    }
    return result
  }, [segments])

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
    if (dragMode.current === 'selecting') {
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
    if (dragMode.current === 'selecting' && !wasDrag) {
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

  return (
    <div style={{
      height: 100, flexShrink: 0,
      background: 'var(--bg-elevated)',
      borderTop: '1px solid var(--border)',
      padding: '8px 16px',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      {/* Labels row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {/* Zoom controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.04em', marginRight: 4 }}>
            TIMELINE
          </span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => applyZoom(zoom / 1.5)}
            disabled={zoom <= 1}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: zoom <= 1 ? 'var(--text-muted)' : 'var(--text)', borderRadius: 3, width: 18, height: 18, fontSize: 13, lineHeight: '16px', cursor: zoom <= 1 ? 'default' : 'pointer', padding: 0, opacity: zoom <= 1 ? 0.4 : 1 }}
          >−</button>
          <span
            style={{ fontSize: 11, color: zoom > 1 ? 'var(--accent)' : 'var(--text-muted)', fontFamily: 'monospace', minWidth: 32, textAlign: 'center', cursor: zoom > 1 ? 'pointer' : 'default' }}
            title={zoom > 1 ? 'Click to reset zoom' : undefined}
            onClick={zoom > 1 ? () => applyZoom(1) : undefined}
          >
            {zoom > 1 ? `${zoom.toFixed(zoom < 10 ? 1 : 0)}×` : '1×'}
          </span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => applyZoom(zoom * 1.5)}
            disabled={zoom >= 100}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: zoom >= 100 ? 'var(--text-muted)' : 'var(--text)', borderRadius: 3, width: 18, height: 18, fontSize: 13, lineHeight: '16px', cursor: zoom >= 100 ? 'default' : 'pointer', padding: 0, opacity: zoom >= 100 ? 0.4 : 1 }}
          >+</button>
        </div>

        {/* Time display */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {selection
            ? `${formatTimecode(selection.start)} → ${formatTimecode(selection.end)}  (${(selection.end - selection.start).toFixed(2)}s)`
            : outputDuration > 0
              ? `${formatTimecode(outputCurrentTime)} / ${formatTimecode(outputDuration)}${outputDuration < duration ? ` · ${formatTimecode(duration - outputDuration)} cut` : ''}`
              : '--:-- / --:--'
          }
        </span>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        style={{
          flex: 1, position: 'relative',
          background: 'var(--bg-card)',
          borderRadius: 4, overflow: 'visible',
          cursor: duration > 0 ? 'crosshair' : 'default',
          border: '1px solid var(--border)',
          userSelect: 'none',
        }}
      >
        {/* Inner clip — leaves room for the scrollbar at the bottom when zoomed */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          bottom: zoom > 1 ? SCROLLBAR_H + 1 : 0,
          borderRadius: zoom > 1 ? '4px 4px 0 0' : 4,
          overflow: 'hidden',
        }}>
          {duration > 0 ? (
            <>
              {/* EDL segment shading */}
              {edlSegments.filter((s) => inView(s.start, s.end)).map((seg) => (
                <div
                  key={seg.id}
                  style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: toLeft(seg.start), width: toWidth(seg.end - seg.start),
                    background: seg.keep ? 'rgba(50,180,100,0.22)' : 'rgba(200,50,50,0.18)',
                  }}
                />
              ))}

              {/* Waveform — slice the visible portion of the waveform array */}
              {waveform.length > 0 && (() => {
                const startIdx = Math.floor((viewStart / duration) * waveform.length)
                const endIdx = Math.ceil(((viewStart + visibleDuration) / duration) * waveform.length)
                const slice = waveform.slice(startIdx, endIdx)
                return (
                  <svg
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                    viewBox={`0 0 ${slice.length} 100`}
                    preserveAspectRatio="none"
                  >
                    {slice.map((amp, i) => {
                      const h = Math.max(1, amp * 90)
                      return <rect key={i} x={i} y={(100 - h) / 2} width={0.7} height={h} fill="rgba(255,255,255,0.2)" />
                    })}
                  </svg>
                )
              })()}

              {/* Pause markers */}
              {pauses.filter((p) => inView(p.time - 0.5, p.time + 0.5)).map((p: { time: number; dur: number }, i: number) => (
                <div
                  key={i}
                  title={`${p.dur.toFixed(1)}s pause`}
                  style={{
                    position: 'absolute', top: 3,
                    left: toLeft(p.time),
                    transform: 'translateX(-50%)',
                    fontSize: p.dur >= 1 ? 11 : 9, lineHeight: 1,
                    color: p.dur >= 1 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.35)',
                    pointerEvents: 'none', userSelect: 'none', fontFamily: 'monospace',
                  }}
                >
                  {p.dur >= 1 ? '~~~' : '~'}
                </div>
              ))}

              {/* Committed word cuts */}
              {wordCuts.filter((c) => inView(c.start, c.end)).map((cut, i) => (
                <div
                  key={i}
                  style={{
                    position: 'absolute', top: '20%', bottom: '20%',
                    left: toLeft(cut.start),
                    width: toWidth(Math.max(0.033, cut.end - cut.start)),
                    background: 'rgba(229,51,51,0.75)', borderRadius: 1,
                  }}
                />
              ))}

              {/* Playhead */}
              {inView(currentTime - 0.1, currentTime + 0.1) && (
                <div
                  style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: toLeft(currentTime),
                    width: 2, background: 'var(--accent)',
                    transform: 'translateX(-50%)',
                    pointerEvents: 'none',
                    boxShadow: '0 0 4px var(--accent)',
                  }}
                />
              )}

              {/* Active selection overlay */}
              {selPct && selPct.width > 0 && (
                <>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${selPct.left}%`, width: `${selPct.width}%`, background: 'rgba(59,130,246,0.28)', pointerEvents: 'none' }} />
                  <div data-handle="left" onPointerDown={(e) => onHandlePointerDown(e, 'left')} style={{ position: 'absolute', top: 0, bottom: 0, width: 6, left: `${selPct.left}%`, transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.9)', cursor: 'ew-resize', zIndex: 2, borderRadius: '2px 0 0 2px' }} />
                  <div data-handle="right" onPointerDown={(e) => onHandlePointerDown(e, 'right')} style={{ position: 'absolute', top: 0, bottom: 0, width: 6, left: `${selPct.left + selPct.width}%`, transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.9)', cursor: 'ew-resize', zIndex: 2, borderRadius: '0 2px 2px 0' }} />
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
            borderRadius: '0 0 4px 4px',
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

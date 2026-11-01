/**
 * Timeline zoom and pan: the visible window over the recording, the track's
 * width, wheel zoom about the cursor, following the playhead, and helpers
 * that map source seconds to positions in the window and back.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { clampViewStart, followPlayhead, labelZoomTarget, maxZoom as maxZoomFor, readableZoom as readableZoomFor, zoomAbout, zoomPercent as zoomPercentFor } from './zoom'

const WHEEL_FACTOR = 1.25 // zoom step per wheel notch

export function useTimelineView(trackRef: RefObject<HTMLDivElement>, duration: number, currentTime: number) {
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [trackWidth, setTrackWidth] = useState(0)
  // Refs so the non-passive wheel handler and the playhead effect read fresh values
  const zoomRef = useRef(1)
  const viewStartRef = useRef(0)
  const durationRef = useRef(duration)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])
  useEffect(() => { durationRef.current = duration }, [duration])

  // Track width in pixels, for ruler spacing and hiding chips too small to read
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setTrackWidth(el.clientWidth))
    observer.observe(el)
    setTrackWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [trackRef])

  const maxZoom = maxZoomFor(duration)
  const visibleDuration = duration > 0 ? duration / zoom : 0
  const pxPerSec = visibleDuration > 0 ? trackWidth / visibleDuration : 0
  // `zoom` is a multiple of the fit-to-width view; the readable scale is what's shown as 100%
  const readableZoom = readableZoomFor(duration, trackWidth)
  const zoomPercent = zoomPercentFor(zoom, duration, trackWidth)
  const labelTarget = labelZoomTarget(zoom, readableZoom)

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
    setViewStart((vs) => clampViewStart(vs, duration, zoom))
  }, [zoom, duration])

  // Auto-scroll to follow the playhead when zoomed in
  useEffect(() => {
    setViewStart((vs) => followPlayhead(currentTime, vs, durationRef.current, zoomRef.current))
  }, [currentTime])

  // Non-passive wheel listener — zooms centered on mouse cursor
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const dur = durationRef.current
      if (dur === 0) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const next = zoomAbout(zoomRef.current, viewStartRef.current, dur, ratio, e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR)
      if (next.zoom === zoomRef.current) return
      setZoom(next.zoom)
      setViewStart(next.viewStart)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [trackRef])

  /** Zoom to `newZoom` (clamped), centred on the playhead. */
  function applyZoom(newZoom: number) {
    if (duration === 0) return
    newZoom = Math.max(1, Math.min(maxZoom, newZoom))
    setZoom(newZoom)
    setViewStart(clampViewStart(currentTime - duration / newZoom / 2, duration, newZoom))
  }

  /** Move the view's left edge to `vs` (clamped); returns where it landed. */
  function panTo(vs: number): number {
    const clamped = clampViewStart(vs, duration, zoom)
    setViewStart(clamped)
    return clamped
  }

  // Position helpers — all times are in source seconds, mapped to visible window
  const toLeft = (time: number) =>
    visibleDuration > 0 ? `${((time - viewStart) / visibleDuration) * 100}%` : '0%'
  const toWidth = (dt: number) =>
    visibleDuration > 0 ? `${(dt / visibleDuration) * 100}%` : '0%'
  const inView = (s: number, e: number) =>
    e > viewStart && s < viewStart + visibleDuration

  /** Screen x → source time, accounting for zoom/pan. */
  function pxToTime(clientX: number): number {
    if (!trackRef.current || duration === 0) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.max(0, Math.min(duration, viewStart + ratio * visibleDuration))
  }

  return {
    zoom, viewStart, trackWidth, visibleDuration, pxPerSec,
    maxZoom, zoomPercent, labelTarget,
    applyZoom, panTo, toLeft, toWidth, inView, pxToTime,
  }
}

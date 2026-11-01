/**
 * Timeline zoom maths. Internally zoom is a multiple of the fit-to-width view
 * (1 = whole recording); the label shows it against a fixed readable scale,
 * so 100% looks the same whatever the recording's length.
 */

export const MIN_VISIBLE = 3          // seconds — most zoomed-in view
export const READABLE_PX_PER_SEC = 45 // px per second at 100% — phrase chips are readable

/** Largest zoom: MIN_VISIBLE seconds across the track. */
export function maxZoom(duration: number): number {
  return Math.max(1, duration / MIN_VISIBLE)
}

/** Zoom that shows the readable scale, clamped to [fit, max]. */
export function readableZoom(duration: number, trackWidth: number): number {
  if (trackWidth <= 0 || duration <= 0) return 1
  return Math.max(1, Math.min(maxZoom(duration), (READABLE_PX_PER_SEC * duration) / trackWidth))
}

/** Label percentage for a zoom: 100 at the readable scale, never below 1. */
export function zoomPercent(zoom: number, duration: number, trackWidth: number): number {
  if (trackWidth <= 0 || duration <= 0) return 100
  const pxPerSec = (trackWidth * zoom) / duration
  return Math.max(1, Math.round((pxPerSec / READABLE_PX_PER_SEC) * 100))
}

/**
 * Zoom to jump to when the label is clicked: fit when zoomed in, 100% when
 * fitted, or null when the whole recording is already readable.
 */
export function labelZoomTarget(zoom: number, readable: number): number | null {
  if (readable <= 1) return null
  return zoom > 1 ? 1 : readable
}

/** The left edge of the view, kept so the view stays inside the recording. */
export function clampViewStart(viewStart: number, duration: number, zoom: number): number {
  return Math.max(0, Math.min(duration - duration / zoom, viewStart))
}

/**
 * Zoom by `factor` about the point `ratio` (0–1) across the track, keeping
 * the time under it fixed. The zoom is clamped to [fit, max].
 */
export function zoomAbout(
  zoom: number,
  viewStart: number,
  duration: number,
  ratio: number,
  factor: number,
): { zoom: number; viewStart: number } {
  const next = Math.max(1, Math.min(maxZoom(duration), zoom * factor))
  const time = viewStart + (ratio * duration) / zoom
  return { zoom: next, viewStart: clampViewStart(time - (ratio * duration) / next, duration, next) }
}

/**
 * The view's left edge after the playhead moves to t: unchanged while t is in
 * view or the whole recording fits, otherwise t sits a tenth of the way in.
 */
export function followPlayhead(t: number, viewStart: number, duration: number, zoom: number): number {
  if (zoom <= 1 || duration === 0) return viewStart
  const visible = duration / zoom
  if (t >= viewStart && t <= viewStart + visible) return viewStart
  return clampViewStart(t - visible * 0.1, duration, zoom)
}

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

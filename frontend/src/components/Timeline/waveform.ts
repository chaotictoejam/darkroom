/**
 * Timeline waveform maths: amplitudes to bar heights, and the visible window
 * reduced to one bar per BAR_PX.
 */

export const BAR_PX = 2            // px per waveform bar
export const NOISE_HEADROOM_DB = 4 // the waveform floor sits this far above the background noise

/**
 * Bar heights in [0, 1] on a dB scale whose floor sits just above the
 * background noise (the quietest tenth of the file), so silence draws flat
 * and speech fills the lane.
 */
export function barHeights(waveform: number[]): number[] {
  if (waveform.length === 0) return []
  const sorted = [...waveform].sort((a, b) => a - b)
  const noise = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.1)])
  const floorDb = Math.min(-20, Math.max(-60, 20 * Math.log10(noise) + NOISE_HEADROOM_DB))
  return waveform.map((amp) => Math.max(0, Math.min(1, 1 - (20 * Math.log10(Math.max(amp, 1e-6))) / floorDb)))
}

/**
 * The bars between viewStart and viewStart + visibleDuration, each the max of
 * `per` buckets so there's about one bar per BAR_PX. `startIdx` is the first
 * bucket, so the caller can place the bars by their buckets' own times.
 */
export function visibleBars(
  heights: number[],
  duration: number,
  viewStart: number,
  visibleDuration: number,
  trackWidth: number,
): { startIdx: number; per: number; bars: number[] } {
  const startIdx = Math.floor((viewStart / duration) * heights.length)
  const endIdx = Math.ceil(((viewStart + visibleDuration) / duration) * heights.length)
  const visible = heights.slice(startIdx, endIdx)
  const per = Math.max(1, Math.floor(visible.length / Math.max(1, trackWidth / BAR_PX)))
  const bars: number[] = []
  for (let i = 0; i < visible.length; i += per) bars.push(Math.max(...visible.slice(i, i + per)))
  return { startIdx, per, bars }
}

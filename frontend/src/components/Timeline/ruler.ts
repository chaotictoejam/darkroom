/** Timeline ruler: tick spacing and labels. */

export const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]
export const TICK_MIN_PX = 70 // px — space between ticks, room for a label

/** Ruler label: m:ss, with tenths when ticks are under a second apart. */
export function formatTick(t: number, step: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0')
  return `${m}:${ss}`
}

/** Ticks in the visible window, at the smallest step that leaves room for a label. */
export function rulerTicks(viewStart: number, visibleDuration: number, pxPerSec: number): { step: number; ticks: number[] } {
  const step = TICK_STEPS.find((s) => s * pxPerSec >= TICK_MIN_PX) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const ticks: number[] = []
  if (pxPerSec > 0) {
    const last = Math.floor((viewStart + visibleDuration) / step)
    for (let k = Math.ceil(viewStart / step); k <= last; k++) ticks.push(k * step)
  }
  return { step, ticks }
}

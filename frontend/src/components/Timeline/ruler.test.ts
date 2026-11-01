import { describe, expect, it } from 'vitest'
import { formatTick, rulerTicks, TICK_MIN_PX, TICK_STEPS } from './ruler'

describe('formatTick', () => {
  it('shows m:ss for steps of a second or more', () => {
    expect(formatTick(0, 1)).toBe('0:00')
    expect(formatTick(65, 5)).toBe('1:05')
    expect(formatTick(3600, 600)).toBe('60:00')
  })

  it('shows tenths for sub-second steps', () => {
    expect(formatTick(1.5, 0.5)).toBe('0:01.5')
    expect(formatTick(62.2, 0.2)).toBe('1:02.2')
  })
})

describe('rulerTicks', () => {
  it('picks the smallest step at least TICK_MIN_PX apart', () => {
    // 20 px/s: 2 s is 40 px, 5 s is 100 px
    expect(rulerTicks(0, 60, 20).step).toBe(5)
    expect(rulerTicks(0, 60, TICK_MIN_PX).step).toBe(1)
  })

  it('falls back to the largest step when zoomed far out', () => {
    expect(rulerTicks(0, 36000, 0.001).step).toBe(TICK_STEPS[TICK_STEPS.length - 1])
  })

  it('lists ticks inside the visible window, ends included', () => {
    expect(rulerTicks(3, 7, 20).ticks).toEqual([5, 10])
    expect(rulerTicks(0, 10, 20).ticks).toEqual([0, 5, 10])
  })

  it('has no ticks before the track has a width', () => {
    expect(rulerTicks(0, 10, 0).ticks).toEqual([])
  })
})

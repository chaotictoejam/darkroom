import { describe, expect, it } from 'vitest'
import { BAR_PX, barHeights, visibleBars } from './waveform'

describe('barHeights', () => {
  it('returns nothing for an empty waveform', () => {
    expect(barHeights([])).toEqual([])
  })

  it('draws the background noise flat and full scale at the top', () => {
    // Noise at -60 dB puts the floor at -56 dB: the noise sits below it, 0 dB at the top
    const waveform = [...Array(11).fill(0.001), ...Array(89).fill(1)]
    const heights = barHeights(waveform)
    expect(heights[0]).toBe(0)
    expect(heights[99]).toBe(1)
  })

  it('keeps every height in [0, 1], including silence and clipping', () => {
    const heights = barHeights([0, 0.01, 0.1, 0.5, 1, 2])
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(1)
    }
  })

  it('rises with amplitude above the floor', () => {
    const [, low, mid, high] = barHeights([1e-5, 0.01, 0.1, 0.5])
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
  })

  it('never puts the floor below -60 dB', () => {
    // All-silent noise would put the floor at -76 dB; clamped to -60, -30 dB is half height
    const waveform = [...Array(10).fill(0), 10 ** (-30 / 20)]
    expect(barHeights(waveform)[10]).toBeCloseTo(0.5)
  })

  it('never puts the floor above -20 dB', () => {
    // Loud noise would put the floor near 0 dB; clamped to -20, -10 dB is half height
    const waveform = [...Array(10).fill(0.9), 10 ** (-10 / 20)]
    expect(barHeights(waveform)[10]).toBeCloseTo(0.5)
  })
})

describe('visibleBars', () => {
  const heights = Array.from({ length: 100 }, (_, i) => i / 100)

  it('shows every bucket when there is room for one bar each', () => {
    const { startIdx, per, bars } = visibleBars(heights, 10, 0, 10, 100 * BAR_PX)
    expect(startIdx).toBe(0)
    expect(per).toBe(1)
    expect(bars).toEqual(heights)
  })

  it('takes the max of each run when buckets outnumber bars', () => {
    const { per, bars } = visibleBars(heights, 10, 0, 10, 25 * BAR_PX)
    expect(per).toBe(4)
    expect(bars).toHaveLength(25)
    expect(bars[0]).toBe(heights[3])
  })

  it('slices to the visible window', () => {
    const { startIdx, bars } = visibleBars(heights, 10, 2, 3, 1000)
    expect(startIdx).toBe(20)
    expect(bars).toEqual(heights.slice(20, 50))
  })

  it('treats a zero-width track as one bar of space', () => {
    const { per, bars } = visibleBars(heights, 10, 0, 10, 0)
    expect(per).toBe(100)
    expect(bars).toEqual([heights[99]])
  })
})

import { describe, expect, it } from 'vitest'
import { labelZoomTarget, maxZoom, MIN_VISIBLE, READABLE_PX_PER_SEC, readableZoom, zoomPercent } from './zoom'

describe('maxZoom', () => {
  it('shows MIN_VISIBLE seconds across the track', () => {
    expect(maxZoom(600)).toBe(600 / MIN_VISIBLE)
  })

  it('never goes below fit for clips shorter than MIN_VISIBLE', () => {
    expect(maxZoom(1)).toBe(1)
  })
})

describe('readableZoom', () => {
  it('gives READABLE_PX_PER_SEC across the track', () => {
    const duration = 1272.8 // 21:12.8
    const width = 1600
    const z = readableZoom(duration, width)
    expect((width * z) / duration).toBeCloseTo(READABLE_PX_PER_SEC)
  })

  it('stays at fit when the whole clip is already readable', () => {
    // 10 s on 1600 px is 160 px/s, wider than the readable scale
    expect(readableZoom(10, 1600)).toBe(1)
  })

  it('is clamped to the maximum zoom on a narrow track', () => {
    expect(readableZoom(600, 50)).toBe(maxZoom(600))
  })

  it('falls back to fit before the track or duration is known', () => {
    expect(readableZoom(0, 1600)).toBe(1)
    expect(readableZoom(600, 0)).toBe(1)
  })
})

describe('zoomPercent', () => {
  it('is 100 at the readable zoom', () => {
    expect(zoomPercent(readableZoom(1272.8, 1600), 1272.8, 1600)).toBe(100)
  })

  it('shows the fit view of a long recording as a small percentage', () => {
    // 21 min on 1600 px is ~1.26 px/s, ~3% of 45 px/s
    expect(zoomPercent(1, 1272.8, 1600)).toBe(3)
  })

  it('never shows 0%', () => {
    expect(zoomPercent(1, 36_000, 400)).toBe(1)
  })

  it('shows over 100% for a short clip that fits wider than readable', () => {
    expect(zoomPercent(1, 10, 1600)).toBe(356)
  })

  it('shows 100% before the track or duration is known', () => {
    expect(zoomPercent(1, 0, 1600)).toBe(100)
    expect(zoomPercent(1, 600, 0)).toBe(100)
  })
})

describe('labelZoomTarget', () => {
  it('goes to 100% from the fit view', () => {
    expect(labelZoomTarget(1, 25)).toBe(25)
  })

  it('goes back to fit when zoomed in', () => {
    expect(labelZoomTarget(25, 25)).toBe(1)
    expect(labelZoomTarget(40, 25)).toBe(1)
  })

  it('does nothing when the whole recording is already readable', () => {
    expect(labelZoomTarget(1, 1)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { clampViewStart, followPlayhead, labelZoomTarget, maxZoom, MIN_VISIBLE, READABLE_PX_PER_SEC, readableZoom, zoomAbout, zoomPercent } from './zoom'

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

describe('clampViewStart', () => {
  it('leaves a view start that fits', () => {
    expect(clampViewStart(30, 100, 2)).toBe(30)
  })

  it('stops the view at the start and end of the recording', () => {
    expect(clampViewStart(-5, 100, 2)).toBe(0)
    expect(clampViewStart(80, 100, 2)).toBe(50)
  })

  it('pins the fit view to the start', () => {
    expect(clampViewStart(10, 100, 1)).toBe(0)
  })
})

describe('zoomAbout', () => {
  it('keeps the time under the cursor fixed', () => {
    // 100 s at 2x shows 20–70; the cursor a fifth in is at 30 s
    const next = zoomAbout(2, 20, 100, 0.2, 2)
    expect(next.zoom).toBe(4)
    expect(next.viewStart + 0.2 * (100 / next.zoom)).toBeCloseTo(30)
  })

  it('clamps the zoom to [fit, max]', () => {
    expect(zoomAbout(1, 0, 100, 0.5, 0.5)).toEqual({ zoom: 1, viewStart: 0 })
    expect(zoomAbout(30, 0, 100, 0, 2).zoom).toBe(maxZoom(100))
  })

  it('keeps the view inside the recording', () => {
    // Zooming out near the end would push the view past it
    expect(zoomAbout(10, 90, 100, 1, 0.5)).toEqual({ zoom: 5, viewStart: 80 })
  })
})

describe('followPlayhead', () => {
  it('stays put while the playhead is in view', () => {
    expect(followPlayhead(25, 20, 100, 4)).toBe(20)
    expect(followPlayhead(45, 20, 100, 4)).toBe(20)
  })

  it('jumps so the playhead sits a tenth of the way in', () => {
    expect(followPlayhead(60, 20, 100, 4)).toBeCloseTo(57.5)
    expect(followPlayhead(10, 20, 100, 4)).toBeCloseTo(7.5)
  })

  it('stays inside the recording', () => {
    expect(followPlayhead(99, 20, 100, 4)).toBe(75)
  })

  it('does nothing at fit or before the duration is known', () => {
    expect(followPlayhead(60, 0, 100, 1)).toBe(0)
    expect(followPlayhead(60, 0, 0, 4)).toBe(0)
  })
})

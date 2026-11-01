import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maxZoom, readableZoom } from './zoom'
import { useTimelineView } from './useTimelineView'

// jsdom has no layout: the track is `width` px wide at x = 0, and ResizeObserver
// is stubbed so a test can announce a resize
let width = 1000
let resize: () => void = () => {}
const disconnect = vi.fn()

let view: ReturnType<typeof useTimelineView>

function Harness({ duration, currentTime = 0, attach = true }: { duration: number; currentTime?: number; attach?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  view = useTimelineView(ref, duration, currentTime)
  return attach ? <div ref={ref} data-testid="track" /> : null
}

beforeEach(() => {
  width = 1000
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resize = cb }
    observe() {}
    disconnect = disconnect
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 0, width, top: 0, height: 100, right: width, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  disconnect.mockClear()
})

describe('useTimelineView', () => {
  it('opens at the readable scale once duration and width are known', () => {
    render(<Harness duration={600} />)
    expect(view.trackWidth).toBe(1000)
    expect(view.zoom).toBe(readableZoom(600, 1000))
    expect(view.zoomPercent).toBe(100)
    expect(view.maxZoom).toBe(maxZoom(600))
    expect(view.visibleDuration).toBeCloseTo(600 / view.zoom)
    expect(view.pxPerSec).toBeCloseTo(1000 / view.visibleDuration)
    expect(view.labelTarget).toBe(1)
  })

  it('waits for a duration before setting the zoom', () => {
    const { rerender } = render(<Harness duration={0} />)
    expect(view.zoom).toBe(1)
    expect(view.visibleDuration).toBe(0)
    expect(view.pxPerSec).toBe(0)
    expect(view.toLeft(5)).toBe('0%')
    expect(view.toWidth(5)).toBe('0%')
    expect(view.pxToTime(500)).toBe(0)
    rerender(<Harness duration={600} />)
    expect(view.zoom).toBe(readableZoom(600, 1000))
  })

  it('waits for a track width before setting the zoom', () => {
    width = 0
    render(<Harness duration={600} />)
    expect(view.zoom).toBe(1)
    width = 1000
    act(() => resize())
    expect(view.trackWidth).toBe(1000)
    expect(view.zoom).toBe(readableZoom(600, 1000))
  })

  it('only sets the opening zoom once', () => {
    render(<Harness duration={600} />)
    act(() => view.applyZoom(1))
    width = 500
    act(() => resize())
    expect(view.trackWidth).toBe(500)
    expect(view.zoom).toBe(1)
  })

  it('maps times to positions in the visible window and back', () => {
    render(<Harness duration={100} />)
    act(() => view.applyZoom(2))  // 0–50 s, centred on the playhead at 0
    expect(view.toLeft(25)).toBe('50%')
    expect(view.toWidth(5)).toBe('10%')
    expect(view.inView(40, 60)).toBe(true)
    expect(view.inView(50, 60)).toBe(false)
    expect(view.pxToTime(250)).toBe(12.5)
    expect(view.pxToTime(-50)).toBe(0)
    expect(view.pxToTime(5000)).toBe(50)
  })

  it('zooms about the playhead and clamps to [fit, max]', () => {
    render(<Harness duration={100} currentTime={50} />)
    act(() => view.applyZoom(4))
    expect(view.zoom).toBe(4)
    expect(view.viewStart).toBe(37.5)
    act(() => view.applyZoom(1000))
    expect(view.zoom).toBe(maxZoom(100))
    act(() => view.applyZoom(0.1))
    expect(view.zoom).toBe(1)
    expect(view.viewStart).toBe(0)
  })

  it('ignores zoom buttons before a duration is known', () => {
    render(<Harness duration={0} />)
    act(() => view.applyZoom(4))
    expect(view.zoom).toBe(1)
  })

  it('pans within the recording and returns where the view landed', () => {
    render(<Harness duration={100} />)
    act(() => view.applyZoom(4))
    let landed = 0
    act(() => { landed = view.panTo(90) })
    expect(landed).toBe(75)
    expect(view.viewStart).toBe(75)
    act(() => { landed = view.panTo(10) })
    expect(view.viewStart).toBe(10)
  })

  it('pulls the view back inside when zooming out from the end', () => {
    render(<Harness duration={100} currentTime={100} />)
    act(() => view.applyZoom(4))
    expect(view.viewStart).toBe(75)
    act(() => view.applyZoom(2))
    expect(view.viewStart).toBe(50)
  })

  it('follows the playhead out of view', () => {
    const { rerender } = render(<Harness duration={100} />)
    act(() => view.applyZoom(4))  // 0–25 s
    rerender(<Harness duration={100} currentTime={10} />)
    expect(view.viewStart).toBe(0)
    rerender(<Harness duration={100} currentTime={60} />)
    expect(view.viewStart).toBeCloseTo(57.5)
  })

  it('zooms in and out with the wheel about the cursor', () => {
    render(<Harness duration={100} />)
    act(() => view.applyZoom(2))  // 0–50 s
    const track = screen.getByTestId('track')
    fireEvent.wheel(track, { deltaY: -1, clientX: 500 })  // cursor at 25 s
    expect(view.zoom).toBe(2.5)
    expect(view.pxToTime(500)).toBeCloseTo(25)
    fireEvent.wheel(track, { deltaY: 1, clientX: 500 })
    expect(view.zoom).toBeCloseTo(2)
  })

  it('stops the wheel at fit, and before a duration is known', () => {
    const { rerender } = render(<Harness duration={100} />)
    act(() => view.applyZoom(1))
    const track = screen.getByTestId('track')
    const zoomOut = new WheelEvent('wheel', { deltaY: 1, cancelable: true })
    track.dispatchEvent(zoomOut)
    expect(zoomOut.defaultPrevented).toBe(true)
    expect(view.zoom).toBe(1)
    rerender(<Harness duration={0} />)
    fireEvent.wheel(track, { deltaY: -1 })
    expect(view.zoom).toBe(1)
  })

  it('stops observing and listening on unmount', () => {
    const { unmount } = render(<Harness duration={100} />)
    const track = screen.getByTestId('track')
    const remove = vi.spyOn(track, 'removeEventListener')
    unmount()
    expect(disconnect).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function))
  })

  it('does nothing without a track element', () => {
    render(<Harness duration={100} attach={false} />)
    expect(view.trackWidth).toBe(0)
    expect(view.pxToTime(500)).toBe(0)
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Pause } from './chunks'
import PauseChip from './PauseChip'

// 1 s = 10% of the track
const toLeft = (t: number) => `${t * 10}%`
const toWidth = (dt: number) => `${dt * 10}%`

function renderChip(pause: Partial<Pause> = {}, props: Partial<Parameters<typeof PauseChip>[0]> = {}) {
  const p: Pause = { start: 2, end: 4, kept: 2, locked: false, ...pause }
  const handlers = { onPointerDown: vi.fn(), onHandlePointerDown: vi.fn() }
  render(
    <PauseChip
      pause={p} kept={p.kept} dragging={false} selected={false} pxPerSec={100}
      toLeft={toLeft} toWidth={toWidth} {...handlers} {...props}
    />,
  )
  return handlers
}

const outline = () => screen.getByTestId('pause-outline')
const keptPart = () => screen.getByTestId('pause-kept')
const handle = () => screen.getByTitle(/drag to shorten or lengthen/)

describe('PauseChip', () => {
  it('spans the recorded length, with the kept part and handle at its edge', () => {
    renderChip({ kept: 1.5 })
    expect(outline().style.left).toBe('20%')
    expect(outline().style.width).toBe('20%')
    expect(keptPart().style.width).toBe('15%')
    expect(handle().style.left).toBe('35%')
    expect(handle().title).toBe('1.50s pause (recorded 2.00s) — drag to shorten or lengthen')
  })

  it('shows the dashed outline only once the pause is shortened', () => {
    renderChip({ kept: 2 })
    expect(outline().style.opacity).toBe('0')
  })

  it('shows the dashed outline for a shortened pause', () => {
    renderChip({ kept: 1 })
    expect(outline().style.opacity).toBe('1')
  })

  it('labels a long pause with its kept length', () => {
    renderChip({ kept: 1.5 })
    expect(keptPart().textContent).toBe('1.5s')
  })

  it('labels a short pause with dots', () => {
    renderChip({ start: 2, end: 2.5, kept: 0.5 })
    expect(keptPart().textContent).toBe('···')
  })

  it('shows the live length while its handle is dragged', () => {
    renderChip({ start: 2, end: 2.5, kept: 0.5 }, { kept: 0.3, dragging: true })
    expect(keptPart().textContent).toBe('0.3s')
    expect(keptPart().style.border).toContain('rgba(59, 130, 246, 0.9)')
  })

  it('drops the label when the kept part is too narrow', () => {
    renderChip({ kept: 1.5 }, { pxPerSec: 10 })
    expect(keptPart().textContent).toBe('')
  })

  it('hides the kept part when the whole pause is cut', () => {
    renderChip({ kept: 0 })
    expect(keptPart().style.display).toBe('none')
  })

  it('looks selected when selected', () => {
    renderChip({}, { selected: true })
    expect(keptPart().style.border).toContain('rgba(59, 130, 246, 0.9)')
  })

  it('looks unselected otherwise', () => {
    renderChip()
    expect(keptPart().style.border).toContain('var(--border)')
  })

  it('shows only the outline when locked', () => {
    renderChip({ kept: 0, locked: true })
    expect(outline().style.opacity).toBe('1')
    expect(screen.queryByTestId('pause-kept')).toBeNull()
    expect(screen.queryByTitle(/drag to shorten/)).toBeNull()
  })

  it('passes presses on the kept part and the handle to their handlers', () => {
    const { onPointerDown, onHandlePointerDown } = renderChip()
    fireEvent.pointerDown(keptPart())
    expect(onPointerDown).toHaveBeenCalledOnce()
    fireEvent.pointerDown(handle())
    expect(onHandlePointerDown).toHaveBeenCalledOnce()
  })

  it('marks the handle so the track ignores presses on it', () => {
    renderChip()
    expect(handle().dataset.handle).toBe('pause')
  })
})

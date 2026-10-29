import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ResizeHandle, { useStoredSize } from './ResizeHandle'

const KEY = 'test.size'

describe('useStoredSize', () => {
  it('uses the fallback when nothing is stored', () => {
    const { result } = renderHook(() => useStoredSize(KEY, 260))
    expect(result.current[0]).toBe(260)
  })

  it('reads a stored size', () => {
    localStorage.setItem(KEY, '320')
    const { result } = renderHook(() => useStoredSize(KEY, 260))
    expect(result.current[0]).toBe(320)
  })

  it.each(['abc', '0', '-50', ''])('ignores an invalid stored value %j', (stored) => {
    localStorage.setItem(KEY, stored)
    const { result } = renderHook(() => useStoredSize(KEY, 260))
    expect(result.current[0]).toBe(260)
  })

  it('updates the size and stores it rounded', () => {
    const { result } = renderHook(() => useStoredSize(KEY, 260))
    act(() => result.current[1](301.6))
    expect(result.current[0]).toBe(301.6)
    expect(localStorage.getItem(KEY)).toBe('302')
  })

  it('falls back when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const { result } = renderHook(() => useStoredSize(KEY, 260))
    expect(result.current[0]).toBe(260)
  })

  it('still resizes when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useStoredSize(KEY, 260))
    act(() => result.current[1](300))
    expect(result.current[0]).toBe(300)
  })
})

function setup(props: Partial<React.ComponentProps<typeof ResizeHandle>> = {}) {
  const onResize = vi.fn()
  render(
    <ResizeHandle
      axis="x" size={300} min={200} max={400} defaultSize={260}
      onResize={onResize} label="Resize panel" {...props}
    />,
  )
  return { handle: screen.getByRole('separator', { name: 'Resize panel' }), onResize }
}

describe('ResizeHandle drag', () => {
  it('grows as the pointer moves right', () => {
    const { handle, onResize } = setup()
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(330)
  })

  it('measures from where the drag started, not the last move', () => {
    const { handle, onResize } = setup()
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(320)
  })

  it('grows as the pointer moves left when inverted', () => {
    const { handle, onResize } = setup({ invert: true })
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 70, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(330)
  })

  it('follows clientY on the y axis', () => {
    const { handle, onResize } = setup({ axis: 'y', invert: true })
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 999, clientY: 460, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(340)
  })

  it('clamps to min and max', () => {
    const { handle, onResize } = setup()
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(400)
    fireEvent.pointerMove(handle, { clientX: -1000, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(200)
  })

  it('ignores moves before a press and after release', () => {
    const { handle, onResize } = setup()
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('ignores buttons other than the primary one', () => {
    const { handle, onResize } = setup()
    fireEvent.pointerDown(handle, { clientX: 100, button: 2, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    expect(onResize).not.toHaveBeenCalled()
  })
})

describe('ResizeHandle keyboard', () => {
  it.each([
    ['x', false, 'ArrowRight', 310],
    ['x', false, 'ArrowLeft', 290],
    ['x', true, 'ArrowLeft', 310],
    ['x', true, 'ArrowRight', 290],
    ['y', false, 'ArrowDown', 310],
    ['y', true, 'ArrowUp', 310],
    ['y', true, 'ArrowDown', 290],
  ] as const)('axis %s, invert %s: %s → %i', (axis, invert, key, expected) => {
    const { handle, onResize } = setup({ axis, invert })
    fireEvent.keyDown(handle, { key })
    expect(onResize).toHaveBeenCalledWith(expected)
  })

  it('takes bigger steps with Shift', () => {
    const { handle, onResize } = setup()
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(onResize).toHaveBeenCalledWith(340)
  })

  it('clamps keyboard steps', () => {
    const { handle, onResize } = setup({ size: 395 })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResize).toHaveBeenCalledWith(400)
  })

  it('ignores other keys and arrows across the axis', () => {
    const { handle, onResize } = setup()
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'Enter' })
    expect(onResize).not.toHaveBeenCalled()
  })
})

describe('ResizeHandle reset', () => {
  it('resets to the default size on double-click', () => {
    const { handle, onResize } = setup()
    fireEvent.doubleClick(handle)
    expect(onResize).toHaveBeenCalledWith(260)
  })

  it('clamps the default when it is outside the current range', () => {
    const { handle, onResize } = setup({ min: 280 })
    fireEvent.doubleClick(handle)
    expect(onResize).toHaveBeenCalledWith(280)
  })

  it('exposes its size and range to assistive tech', () => {
    const { handle } = setup({ size: 301.4 })
    expect(handle.getAttribute('aria-valuenow')).toBe('301')
    expect(handle.getAttribute('aria-valuemin')).toBe('200')
    expect(handle.getAttribute('aria-valuemax')).toBe('400')
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
  })
})

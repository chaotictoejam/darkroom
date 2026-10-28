/**
 * Drag handle on the edge between two panels, plus a hook that remembers the
 * panel size in localStorage. Double-click the handle to reset to the default.
 */
import { useCallback, useRef, useState } from 'react'

const HIT = 6 // px — grab area, centred on the edge

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** A panel size that survives reloads; falls back to `fallback` if storage is unavailable. */
export function useStoredSize(key: string, fallback: number): [number, (size: number) => void] {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key))
      return v > 0 ? v : fallback
    } catch {
      return fallback
    }
  })
  const update = useCallback((next: number) => {
    setSize(next)
    try { localStorage.setItem(key, String(Math.round(next))) } catch { /* not persisted */ }
  }, [key])
  return [size, update]
}

export default function ResizeHandle({
  axis,
  size,
  min,
  max,
  defaultSize,
  invert = false,
  onResize,
  label,
}: {
  /** `x` resizes a width (vertical bar), `y` a height (horizontal bar). */
  axis: 'x' | 'y'
  size: number
  min: number
  max: number
  defaultSize: number
  /** True when the panel grows as the pointer moves left/up (it sits right of/below the handle). */
  invert?: boolean
  onResize: (size: number) => void
  label: string
}) {
  const [active, setActive] = useState(false)
  const [hover, setHover] = useState(false)
  const start = useRef({ pos: 0, size: 0 })

  const pos = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { pos: pos(e), size }
    setActive(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return
    const delta = (pos(e) - start.current.pos) * (invert ? -1 : 1)
    onResize(clamp(start.current.size + delta, min, max))
  }
  const onPointerUp = () => setActive(false)

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10
    const grow = axis === 'x' ? (invert ? 'ArrowLeft' : 'ArrowRight') : (invert ? 'ArrowUp' : 'ArrowDown')
    const shrink = axis === 'x' ? (invert ? 'ArrowRight' : 'ArrowLeft') : (invert ? 'ArrowDown' : 'ArrowUp')
    if (e.key === grow) onResize(clamp(size + step, min, max))
    else if (e.key === shrink) onResize(clamp(size - step, min, max))
    else return
    e.preventDefault()
  }

  const horizontal = axis === 'x'
  return (
    // Zero-size wrapper so the handle overlaps the panel border without taking layout space
    <div style={{
      position: 'relative', flexShrink: 0, zIndex: 5,
      ...(horizontal ? { width: 0 } : { height: 0 }),
    }}>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={label}
        aria-valuenow={Math.round(size)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={`${label} — drag to resize, double-click to reset`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onDoubleClick={() => onResize(clamp(defaultSize, min, max))}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute',
          ...(horizontal
            ? { top: 0, bottom: 0, left: -HIT / 2, width: HIT, cursor: 'col-resize' }
            : { left: 0, right: 0, top: -HIT / 2, height: HIT, cursor: 'row-resize' }),
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          flexDirection: horizontal ? 'row' : 'column',
          touchAction: 'none', outline: 'none',
        }}
      >
        {/* Accent line shown while hovered or dragging */}
        <div style={{
          ...(horizontal ? { width: 2, height: '100%' } : { height: 2, width: '100%' }),
          background: 'var(--accent)',
          opacity: active || hover ? 1 : 0,
          transition: 'opacity 0.12s',
        }} />
      </div>
    </div>
  )
}

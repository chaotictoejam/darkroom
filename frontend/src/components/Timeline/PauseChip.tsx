/**
 * A pause in the word lane. The solid part is what's kept and the dashed
 * outline is the recorded length; the handle at the kept edge drags it
 * shorter or longer. Locked pauses (cut by the EDL or a wider manual cut)
 * show only the outline.
 */
import type { PointerEvent } from 'react'
import type { Pause } from './chunks'
import { chipBase, LANE_H, LANE_TOP, SELECTED, selectedChip, unselectedChip } from './layout'

const PAUSE_LABEL_MIN = 0.8 // seconds — longer pauses show their length, shorter show ···
const LABEL_MIN_PX = 22     // narrower kept parts have no label

export default function PauseChip({
  pause,
  kept,
  dragging,
  selected,
  pxPerSec,
  toLeft,
  toWidth,
  onPointerDown,
  onHandlePointerDown,
}: {
  pause: Pause
  /** Seconds kept: the pause's own, or the live value while its handle is dragged. */
  kept: number
  dragging: boolean
  selected: boolean
  pxPerSec: number
  toLeft: (time: number) => string
  toWidth: (dt: number) => string
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onHandlePointerDown: (e: PointerEvent<HTMLDivElement>) => void
}) {
  const full = pause.end - pause.start
  const label = full >= PAUSE_LABEL_MIN || dragging ? `${kept.toFixed(1)}s` : '···'
  return (
    <div>
      <div data-testid="pause-outline" style={{
        ...chipBase,
        left: toLeft(pause.start), width: toWidth(full),
        border: '1px dashed var(--border)',
        opacity: kept < full - 0.01 || pause.locked ? 1 : 0,
      }} />
      {!pause.locked && (
        <>
          <div
            data-testid="pause-kept"
            onPointerDown={onPointerDown}
            style={{
              ...chipBase,
              left: toLeft(pause.start), width: toWidth(kept),
              ...(dragging || selected ? selectedChip : unselectedChip),
              pointerEvents: 'auto', cursor: 'pointer',
              color: 'var(--text-muted)', textAlign: 'center',
              display: kept > 0 ? 'block' : 'none',
            }}
          >
            {kept * pxPerSec >= LABEL_MIN_PX ? label : ''}
          </div>
          <div
            data-handle="pause"
            onPointerDown={onHandlePointerDown}
            title={`${kept.toFixed(2)}s pause (recorded ${full.toFixed(2)}s) — drag to shorten or lengthen`}
            style={{
              position: 'absolute', top: LANE_TOP, height: LANE_H,
              left: toLeft(pause.start + kept), width: 8, transform: 'translateX(-50%)',
              cursor: 'ew-resize', zIndex: 3,
              display: 'flex', justifyContent: 'center',
            }}
          >
            <div style={{ width: 2, margin: '4px 0', borderRadius: 1, background: dragging ? SELECTED : 'var(--text-muted)', opacity: dragging ? 1 : 0.6 }} />
          </div>
        </>
      )}
    </div>
  )
}

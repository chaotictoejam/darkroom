/** Timeline lane geometry and the chip styles shared by phrase and pause chips. */
import type { CSSProperties } from 'react'

export const SCROLLBAR_H = 7        // px — height of the scrollbar strip
export const RULER_H = 18           // px
export const LANE_TOP = RULER_H + 3 // px — top of the word lane
export const LANE_H = 22            // px
export const WAVE_TOP = LANE_TOP + LANE_H + 4

export const SELECTED = 'rgba(59,130,246,0.9)'

export const chipBase: CSSProperties = {
  position: 'absolute', top: LANE_TOP, height: LANE_H,
  borderRadius: 4, fontSize: 11, lineHeight: `${LANE_H}px`,
  overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
  boxSizing: 'border-box', pointerEvents: 'none',
}

export const selectedChip: CSSProperties = {
  background: 'rgba(59,130,246,0.3)', border: `1px solid ${SELECTED}`,
}

export const unselectedChip: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
}

import { describe, expect, it } from 'vitest'
import {
  chipBase, LANE_H, LANE_TOP, RULER_H, SELECTED, selectedChip, unselectedChip, WAVE_TOP,
} from './layout'

describe('timeline layout', () => {
  it('keeps the word lane between the ruler and waveform, without overlapping either', () => {
    expect(LANE_TOP).toBeGreaterThan(RULER_H)
    expect(WAVE_TOP).toBeGreaterThan(LANE_TOP + LANE_H)
  })

  it('fits chips to the word lane without intercepting pointer events', () => {
    expect(chipBase).toMatchObject({
      position: 'absolute',
      top: LANE_TOP,
      height: LANE_H,
      lineHeight: `${LANE_H}px`,
      pointerEvents: 'none',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
  })

  it('distinguishes the selected chip without resizing the border', () => {
    expect(selectedChip.border).toBe(`1px solid ${SELECTED}`)
    expect(unselectedChip.border).toBe('1px solid var(--border)')
    expect(selectedChip.background).not.toBe(unselectedChip.background)
  })
})

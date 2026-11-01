import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Waveform from './Waveform'

// 1 s = 10% of the track
const toLeft = (t: number) => `${t * 10}%`
const toWidth = (dt: number) => `${dt * 10}%`

function renderWaveform(waveform: number[], props: Partial<Parameters<typeof Waveform>[0]> = {}) {
  return render(
    <Waveform
      waveform={waveform} duration={10} viewStart={0} visibleDuration={10} trackWidth={1000}
      toLeft={toLeft} toWidth={toWidth} {...props}
    />,
  )
}

describe('Waveform', () => {
  it('draws nothing before the waveform loads', () => {
    const { container } = renderWaveform([])
    expect(container.querySelector('svg')).toBeNull()
  })

  it('draws a bar per bucket, silence flat and peaks full height', () => {
    const waveform = [...Array(11).fill(0.001), ...Array(9).fill(1)]
    const { container } = renderWaveform(waveform)
    const rects = container.querySelectorAll('rect')
    expect(rects).toHaveLength(20)
    expect(rects[0].getAttribute('height')).toBe('0.6')
    expect(rects[19].getAttribute('height')).toBe('94')
    expect(rects[19].getAttribute('y')).toBe('3')
  })

  it('places the visible slice by its buckets\' own times', () => {
    // 20 buckets over 10 s; the view 2.5–7.5 s starts at bucket 5
    const { container } = renderWaveform(Array(20).fill(0.5), { viewStart: 2.5, visibleDuration: 5 })
    const svg = container.querySelector('svg')!
    expect(svg.style.left).toBe('25%')
    expect(svg.style.width).toBe('50%')
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 100')
  })
})

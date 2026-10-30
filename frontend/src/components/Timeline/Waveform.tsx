/**
 * The visible part of the waveform, one bar per BAR_PX (max of each run),
 * placed by its buckets' own times so bars line up with the words.
 */
import { useMemo } from 'react'
import { WAVE_TOP } from './layout'
import { barHeights as barHeightsFor, visibleBars } from './waveform'

export default function Waveform({
  waveform,
  duration,
  viewStart,
  visibleDuration,
  trackWidth,
  toLeft,
  toWidth,
}: {
  /** Peak amplitude per bucket, evenly spread over the recording. */
  waveform: number[]
  duration: number
  viewStart: number
  visibleDuration: number
  trackWidth: number
  toLeft: (time: number) => string
  toWidth: (dt: number) => string
}) {
  const heights = useMemo(() => barHeightsFor(waveform), [waveform])
  if (waveform.length === 0) return null
  const { startIdx, per, bars } = visibleBars(heights, duration, viewStart, visibleDuration, trackWidth)
  const bucketDur = duration / waveform.length
  return (
    <svg
      aria-hidden
      style={{ position: 'absolute', top: WAVE_TOP, left: toLeft(startIdx * bucketDur), width: toWidth(bars.length * per * bucketDur), height: `calc(100% - ${WAVE_TOP}px)`, pointerEvents: 'none', fill: 'var(--text)', fillOpacity: 0.6 }}
      viewBox={`0 0 ${bars.length} 100`}
      preserveAspectRatio="none"
    >
      {bars.map((amp, i) => {
        const h = Math.max(0.6, amp * 94)
        return <rect key={i} x={i} y={(100 - h) / 2} width={0.75} height={h} />
      })}
    </svg>
  )
}

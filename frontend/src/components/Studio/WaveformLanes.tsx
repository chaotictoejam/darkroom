/**
 * Scrolling waveform lanes, one per microphone, in the style of Audacity or
 * Descript: the newest audio sits at a fixed playhead on the right and older
 * audio scrolls left. Audio recorded into a take is drawn in the accent
 * colour; audio heard between takes is drawn grey.
 *
 * Every lane keeps the whole session, so the user can scroll back (wheel or
 * trackpad) while recording, and jump back to live.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import LevelMeter from './LevelMeter'
import { PEAKS_PER_SECOND, type MicEngine } from './micEngine'

const PX_PER_SECOND = 50
const LANE_HEIGHT = 72

/** A span on the audio clock that was recorded into a take; end is null while recording. */
export interface RecordedSpan {
  start: number
  end: number | null
}

export interface LaneInfo {
  key: string
  name: string
  device: string
}

interface Props {
  engine: MicEngine
  lanes: LaneInfo[]
  spans: MutableRefObject<RecordedSpan[]>
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export default function WaveformLanes({ engine, lanes, spans }: Props) {
  const canvases = useRef(new Map<string, HTMLCanvasElement>())
  // null = follow live; otherwise the audio-clock time shown at the right edge
  const viewEnd = useRef<number | null>(null)
  const [scrolledBack, setScrolledBack] = useState(false)

  useEffect(() => {
    const accent = cssVar('--accent', '#e53')
    const muted = cssVar('--border', '#333')
    const bg = cssVar('--bg-elevated', '#1a1a1a')
    let raf = 0

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const now = engine.now
      const end = viewEnd.current ?? now
      for (const [key, canvas] of canvases.current) {
        const W = Math.round(canvas.clientWidth * dpr)
        const H = Math.round(canvas.clientHeight * dpr)
        if (canvas.width !== W || canvas.height !== H) {
          canvas.width = W
          canvas.height = H
        }
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = bg
        ctx.fillRect(0, 0, W, H)
        const lane = engine.lanes.get(key)
        if (!lane || lane.t0 === null) continue

        const secPerPx = 1 / (PX_PER_SECOND * dpr)
        const mid = H / 2
        const col = Math.max(1, Math.round(dpr))
        for (let x = 0; x < W; x += col) {
          const t = end - (W - x) * secPerPx
          const i0 = (t - lane.t0) * PEAKS_PER_SECOND
          const i1 = i0 + col * secPerPx * PEAKS_PER_SECOND
          if (i1 <= 0 || i0 >= lane.peaks.length) continue
          const peak = lane.peaks.max(i0, Math.max(i1, i0 + 1))
          // sqrt keeps quiet speech visible without flattening loud peaks
          const h = Math.max(dpr, Math.sqrt(peak) * (H - 4 * dpr))
          const recorded = spans.current.some((s) => t >= s.start && t <= (s.end ?? now))
          ctx.fillStyle = recorded ? accent : muted
          ctx.fillRect(x, mid - h / 2, col, h)
        }
        if (viewEnd.current === null) {
          ctx.fillStyle = spans.current.some((s) => s.end === null) ? accent : '#888'
          ctx.fillRect(W - 2 * dpr, 0, 2 * dpr, H)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [engine, spans])

  function handleWheel(e: React.WheelEvent) {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    const now = engine.now
    const earliest = Math.min(...[...engine.lanes.values()].map((l) => l.t0 ?? now))
    const next = Math.max(earliest, (viewEnd.current ?? now) + delta / PX_PER_SECOND)
    viewEnd.current = next >= now ? null : next
    setScrolledBack(viewEnd.current !== null)
  }

  function backToLive() {
    viewEnd.current = null
    setScrolledBack(false)
  }

  return (
    <div style={{ position: 'relative' }} onWheel={handleWheel}>
      {lanes.map((lane) => (
        <div key={lane.key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{ width: 150, flexShrink: 0, minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.name}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {lane.device}
            </div>
          </div>
          <canvas
            ref={(el) => { if (el) canvases.current.set(lane.key, el); else canvases.current.delete(lane.key) }}
            style={{ flex: 1, minWidth: 0, height: LANE_HEIGHT, borderRadius: 6, display: 'block' }}
          />
          <LevelMeter engine={engine} laneKey={lane.key} />
        </div>
      ))}
      {scrolledBack && (
        <button
          onClick={backToLive}
          style={{
            position: 'absolute', top: 4, right: 120,
            background: 'var(--accent)', color: '#fff', border: 'none',
            borderRadius: 12, padding: '2px 10px', fontSize: 11, fontWeight: 600,
          }}
        >
          Back to live ▸
        </button>
      )}
    </div>
  )
}

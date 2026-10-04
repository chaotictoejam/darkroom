/**
 * Horizontal level meter in dBFS with peak hold and a latching clip light.
 * Drawn to a canvas every frame straight from the engine, without React renders.
 */
import { useEffect, useRef } from 'react'
import type { MicEngine } from './micEngine'

const FLOOR_DB = -60
const HOLD_SECONDS = 1.5
const CLIP_W = 10

function toFraction(peak: number): number {
  if (peak <= 0) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(1, 1 - db / FLOOR_DB))
}

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

interface Props {
  engine: MicEngine
  laneKey: string
  width?: number
  height?: number
}

export default function LevelMeter({ engine, laneKey, width = 96, height = 10 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')!
    const bg = cssVar(canvas, '--bg-elevated') || '#1a1a1a'
    let hold = 0
    let holdAt = 0
    let raf = 0

    const draw = () => {
      const lane = engine.lanes.get(laneKey)
      const level = toFraction(engine.level(laneKey))
      const t = performance.now() / 1000
      if (level >= hold || t - holdAt > HOLD_SECONDS) {
        hold = level
        holdAt = t
      }
      const W = canvas.width
      const H = canvas.height
      const barW = W - (CLIP_W + 3) * dpr
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, barW, H)
      // Green up to -12 dB, amber to -3 dB, red above
      const zones: [number, number, string][] = [[0, 0.8, '#4c8'], [0.8, 0.95, '#eb3'], [0.95, 1, '#f55']]
      for (const [from, to, color] of zones) {
        const end = Math.min(level, to)
        if (end <= from) continue
        ctx.fillStyle = color
        ctx.fillRect(from * barW, 0, (end - from) * barW, H)
      }
      if (hold > 0) {
        ctx.fillStyle = hold > 0.95 ? '#f55' : '#ddd'
        ctx.fillRect(Math.max(0, hold * barW - 2 * dpr), 0, 2 * dpr, H)
      }
      ctx.fillStyle = lane?.clipped ? '#f33' : bg
      ctx.fillRect(W - CLIP_W * dpr, 0, CLIP_W * dpr, H)
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [engine, laneKey, width, height])

  return (
    <canvas
      ref={canvasRef}
      title="Level. The light on the right turns red if the input clipped; click to reset it."
      onClick={() => {
        const lane = engine.lanes.get(laneKey)
        if (lane) lane.clipped = false
      }}
      style={{ width, height, borderRadius: 2, cursor: 'pointer', display: 'block' }}
    />
  )
}

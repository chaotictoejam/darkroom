/**
 * The music lane: one block per sound cue, under the speaker waveform.
 *
 * Blocks are drawn in source time like the rest of the timeline, so cutting
 * speech moves them along with the words they sit under. Click a block to open
 * it in the Music panel, drag it to move it, or drag a bed's right edge to
 * change where it stops.
 */
import type { CSSProperties } from 'react'
import { cueTooltip, kindLabel, type CueBlock } from './musicCues'

const BLOCK_MIN_PX = 4   // narrower blocks are hidden
const LABEL_MIN_PX = 44  // below this the block shows no text
const HANDLE_PX = 6

export default function MusicLane({
  blocks,
  bottom,
  height,
  name,
  muted,
  pxPerSec,
  toLeft,
  toWidth,
  inView,
  selectedId,
  onSelect,
  onMovePointerDown,
  onTrimPointerDown,
}: {
  blocks: CueBlock[]
  /** Distance from the bottom of the track to the lane, in px. */
  bottom: number
  height: number
  /** The sound track's name, shown at the left of the lane. */
  name: string
  muted: boolean
  pxPerSec: number
  toLeft: (time: number) => string
  toWidth: (dt: number) => string
  inView: (start: number, end: number) => boolean
  selectedId: string | null
  onSelect: (cueId: string) => void
  onMovePointerDown: (e: React.PointerEvent<HTMLDivElement>, block: CueBlock) => void
  onTrimPointerDown: (e: React.PointerEvent<HTMLDivElement>, block: CueBlock) => void
}) {
  const lane: CSSProperties = {
    position: 'absolute', left: 0, right: 0, bottom, height,
    background: 'var(--bg-card)', borderRadius: 4, overflow: 'hidden',
  }
  return (
    <>
      <div style={lane} aria-hidden />
      <span style={{
        position: 'absolute', bottom: bottom + height - 11, left: 4, zIndex: 1,
        fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase',
        color: 'var(--text-muted)', pointerEvents: 'none',
      }}>
        {name}{muted ? ' · muted' : ''}
      </span>
      {blocks.filter((b) => inView(b.start, b.end) && (b.end - b.start) * pxPerSec >= BLOCK_MIN_PX)
        .map((block) => {
          const width = (block.end - block.start) * pxPerSec
          const selected = block.cue.id === selectedId
          return (
            <div
              key={block.cue.id}
              role="button"
              tabIndex={0}
              aria-label={`${block.name} — ${kindLabel(block.cue.kind)}`}
              aria-pressed={selected}
              title={cueTooltip(block)}
              onPointerDown={(e) => onMovePointerDown(e, block)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(block.cue.id)
                }
              }}
              style={{
                position: 'absolute', bottom: bottom + 2, height: height - 4,
                left: toLeft(block.start), width: toWidth(block.end - block.start),
                boxSizing: 'border-box', borderRadius: 3, cursor: 'grab',
                display: 'flex', alignItems: 'center', gap: 4,
                padding: width >= LABEL_MIN_PX ? '0 6px' : 0,
                fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden',
                opacity: block.missing || muted ? 0.45 : 1,
                background: selected ? 'rgba(59,130,246,0.35)' : 'rgba(129,140,248,0.22)',
                border: `1px solid ${selected ? 'rgba(59,130,246,0.95)' : 'rgba(129,140,248,0.6)'}`,
                color: 'var(--text)',
              }}
            >
              {width >= LABEL_MIN_PX && (
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {block.missing ? '⚠ ' : ''}{block.name}
                </span>
              )}
              {block.cue.kind === 'bed' && width >= HANDLE_PX * 3 && (
                <div
                  data-handle="cue-end"
                  onPointerDown={(e) => onTrimPointerDown(e, block)}
                  title="Drag to change where the music stops"
                  style={{
                    position: 'absolute', top: 0, bottom: 0, right: 0, width: HANDLE_PX,
                    cursor: 'ew-resize', background: 'rgba(129,140,248,0.8)',
                    borderRadius: '0 3px 3px 0',
                  }}
                />
              )}
            </div>
          )
        })}
    </>
  )
}

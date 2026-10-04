/**
 * Takes strip: one chip per take in timeline order, with its length and
 * transcription status. Chips can be dragged to reorder and deleted.
 */
import { useState } from 'react'
import type { Take } from '../../api/types'
import { formatElapsed } from './format'

interface Props {
  takes: Take[]
  /** Live length of the take being recorded */
  recordingElapsed: number
  /** Reordering and deleting are paused while a take is recording or saving */
  locked: boolean
  onReorder: (order: string[]) => void
  onDelete: (take: Take, position: number) => void
  onRetry: (take: Take) => void
}

function status(take: Take, recordingElapsed: number): { label: string; color: string; title?: string } {
  if (take.status === 'recording') return { label: `● ${formatElapsed(recordingElapsed)}`, color: 'var(--accent)' }
  if (take.status === 'finalizing') return { label: 'saving…', color: 'var(--text-muted)' }
  if (take.status === 'error') return { label: '⚠ no audio', color: '#f55', title: take.error ?? undefined }
  const t = take.transcription
  const length = formatElapsed(take.duration)
  if (t.status === 'done') return { label: `✓ ${length}`, color: '#4c8', title: 'Transcribed' }
  if (t.status === 'transcribing') return { label: `⏳ ${length} · ${t.percent}%`, color: 'var(--text-muted)', title: 'Transcribing' }
  if (t.status === 'error') return { label: `⚠ ${length} · retry`, color: '#f55', title: t.error ?? 'Transcription failed' }
  return { label: `⏳ ${length}`, color: 'var(--text-muted)', title: 'Waiting to transcribe' }
}

export default function TakesStrip({ takes, recordingElapsed, locked, onReorder, onDelete, onRetry }: Props) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  function drop(targetId: string) {
    if (!dragging || dragging === targetId) return
    // The dragged take takes the target's place; the rest shift along
    const order = takes.map((t) => t.id)
    const to = order.indexOf(targetId)
    order.splice(order.indexOf(dragging), 1)
    order.splice(to, 0, dragging)
    onReorder(order)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Takes</span>
      {takes.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>none yet</span>}
      {takes.map((take, i) => {
        const s = status(take, recordingElapsed)
        const busy = take.status === 'recording' || take.status === 'finalizing'
        const canDrag = !locked && !busy
        const retry = take.status === 'ready' && take.transcription.status === 'error'
        return (
          <div
            key={take.id}
            draggable={canDrag}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragging(take.id) }}
            onDragEnd={() => { setDragging(null); setOver(null) }}
            onDragOver={(e) => { if (dragging && canDrag) { e.preventDefault(); setOver(take.id) } }}
            onDragLeave={() => setOver((o) => (o === take.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); drop(take.id); setOver(null) }}
            title={s.title}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--bg-card)', borderRadius: 6, padding: '4px 6px 4px 10px',
              border: `1px solid ${over === take.id ? 'var(--accent)' : take.status === 'recording' ? 'var(--accent)' : 'var(--border)'}`,
              opacity: dragging === take.id ? 0.4 : 1,
              cursor: canDrag ? 'grab' : 'default',
              fontSize: 12, fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span style={{ fontWeight: 600 }}>{i + 1}</span>
            {retry ? (
              <button onClick={() => onRetry(take)} style={{ background: 'none', border: 'none', color: s.color, padding: 0, fontSize: 12 }}>
                {s.label}
              </button>
            ) : (
              <span style={{ color: s.color }}>{s.label}</span>
            )}
            {!busy && (
              <button
                onClick={() => onDelete(take, i + 1)}
                aria-label={`Delete take ${i + 1}`}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: '0 2px', fontSize: 11 }}
              >
                ✕
              </button>
            )}
          </div>
        )
      })}
      {takes.length > 1 && !locked && (
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Drag to reorder</span>
      )}
    </div>
  )
}

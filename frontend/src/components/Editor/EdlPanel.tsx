/**
 * Sidebar list of EDL segments: seek to one, or cut and restore segments.
 */
import type { EDL } from '../../api/types'
import { formatTimecode } from '../../formatTime'

export default function EdlPanel({ edl, onSeek, onSetKept }: {
  edl: EDL
  onSeek: (t: number) => void
  onSetKept: (ids: Set<string>, keep: boolean) => void
}) {
  const kept = edl.segments.filter((s) => s.keep).length
  const cut = edl.segments.length - kept
  const cutIds = new Set(edl.segments.filter((s) => !s.keep).map((s) => s.id))

  return (
    <div>
      <div style={{
        padding: '6px 12px 8px',
        fontSize: 11, color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 12,
      }}>
        <span style={{ color: '#4c8' }}>● {kept} kept</span>
        <span style={{ color: '#e55' }}>● {cut} cut</span>
        {cut > 0 && (
          <button
            onClick={() => onSetKept(cutIds, true)}
            title="Keep every segment the EDL cut"
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', padding: 0,
              color: 'var(--accent)', fontSize: 11, cursor: 'pointer',
            }}
          >
            Restore all
          </button>
        )}
      </div>

      {edl.segments.map((seg) => (
        <div
          key={seg.id}
          onClick={() => onSeek(seg.start)}
          style={{
            padding: '7px 12px 7px 10px',
            borderLeft: `3px solid ${seg.keep ? 'rgba(60,200,110,0.55)' : 'rgba(210,55,55,0.5)'}`,
            borderBottom: '1px solid var(--border)',
            cursor: 'pointer',
            display: 'flex', flexDirection: 'column', gap: 3,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-card)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {/* Time + badges row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
              {formatTimecode(seg.start)} → {formatTimecode(seg.end)}
            </span>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
              padding: '1px 5px', borderRadius: 3,
              background: seg.keep ? 'rgba(60,200,110,0.15)' : 'rgba(210,55,55,0.15)',
              color: seg.keep ? '#4c8' : '#e55',
            }}>
              {seg.keep ? 'KEEP' : 'CUT'}
            </span>
            {seg.camera && (
              <span style={{
                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--text-muted)',
                padding: '1px 5px', borderRadius: 3,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
              }}>
                CAM {seg.camera}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onSetKept(new Set([seg.id]), !seg.keep)
              }}
              title={seg.keep ? 'Cut this segment' : 'Keep this segment'}
              style={{
                marginLeft: 'auto', flexShrink: 0,
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 3,
                color: 'var(--text-muted)', fontSize: 10, padding: '1px 6px', cursor: 'pointer',
              }}
            >
              {seg.keep ? 'Cut' : 'Restore'}
            </button>
          </div>

          {/* Reason */}
          {seg.reason && (
            <div style={{
              fontSize: 11, color: 'var(--text-muted)',
              lineHeight: 1.35, fontStyle: 'italic',
            }}>
              {seg.reason}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

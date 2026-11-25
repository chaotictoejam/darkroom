/**
 * Floating toolbar above the timeline selection: Cut, Restore (when it holds
 * cuts), Re-transcribe and close.
 */
import type { CSSProperties, ReactNode } from 'react'

function ToolbarButton({ onClick, style, label, title, disabled, children }: {
  onClick: () => void
  style: CSSProperties
  label?: string
  title?: string
  disabled?: boolean
  children: ReactNode
}) {
  // A disabled button receives no mouse events, so the hover handlers need no guard.
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      aria-label={label}
      title={title}
      disabled={disabled}
      style={{
        background: 'none', border: 'none', borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#2e2e2e' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
    >
      {children}
    </button>
  )
}

export default function SelectionToolbar({
  center,
  length,
  canRestore,
  retranscribing,
  onCut,
  onRestore,
  onRetranscribe,
  onClose,
}: {
  /** Horizontal centre of the selection, as a percentage of the track. */
  center: number
  /** Selection length in seconds. */
  length: number
  canRestore: boolean
  /** Whether Whisper is running over this selection right now. */
  retranscribing: boolean
  onCut: () => void
  onRestore: () => void
  /** Re-run Whisper over the selection and splice the result into the transcript. */
  onRetranscribe: () => void
  onClose: () => void
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 6px)',
        left: `${Math.max(5, Math.min(95, center))}%`,
        transform: 'translateX(-50%)',
        zIndex: 100,
        display: 'flex', alignItems: 'center', gap: 1,
        background: '#1c1c1c', border: '1px solid #3a3a3a',
        borderRadius: 7, padding: '3px 4px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        fontSize: 12, whiteSpace: 'nowrap',
      }}
    >
      <ToolbarButton onClick={onCut} style={{ color: '#e05555', padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>
        ✂ Cut {length.toFixed(2)}s
      </ToolbarButton>
      {canRestore && (
        <ToolbarButton onClick={onRestore} style={{ color: '#5cbf7a', padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>
          ↺ Restore
        </ToolbarButton>
      )}
      <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />
      <ToolbarButton
        onClick={onRetranscribe}
        disabled={retranscribing}
        title="Transcribe this stretch again on its own — for speech the first pass dropped or misheard"
        style={{ color: '#7aa7d9', padding: '3px 10px', fontSize: 12, fontWeight: 600 }}
      >
        {retranscribing ? '⟳ Listening…' : '⟳ Re-transcribe'}
      </ToolbarButton>
      <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />
      <ToolbarButton onClick={onClose} label="Clear selection" style={{ color: '#888', padding: '3px 8px', fontSize: 11 }}>
        ✕
      </ToolbarButton>
    </div>
  )
}

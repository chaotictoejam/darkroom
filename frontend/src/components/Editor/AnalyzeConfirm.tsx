/**
 * Confirm step before Analyse: names where the transcript will go before anything is sent.
 */
import type { AiStatus } from '../../api/types'

export default function AnalyzeConfirm({
  ai,
  onCancel,
  onConfirm,
}: {
  ai: AiStatus
  onCancel: () => void
  onConfirm: () => void
}) {
  const thirdParty = ai.provider === 'anthropic'
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        role="dialog"
        aria-labelledby="analyze-confirm-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '28px 32px',
          width: 420,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div id="analyze-confirm-title" style={{ fontWeight: 600, fontSize: 16 }}>
          Send the transcript to {ai.destination}?
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            The transcript text (not your audio or video) leaves this computer so{' '}
            <code style={{ fontSize: 12 }}>{ai.model}</code> can write the edit decision list.
          </div>
          <div style={{ color: thirdParty ? '#e8a33d' : 'inherit' }}>{ai.detail}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              background: 'none', border: '1px solid var(--border)',
              color: 'var(--text)', borderRadius: 6, padding: '7px 18px',
              fontSize: 13, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            style={{
              background: 'var(--accent)', border: 'none',
              color: '#fff', borderRadius: 6, padding: '7px 18px',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Send & analyze
          </button>
        </div>
      </div>
    </div>
  )
}

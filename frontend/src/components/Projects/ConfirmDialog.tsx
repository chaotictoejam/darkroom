/** Yes/no dialog for the destructive actions on Welcome. */
import ModalShell from './ModalShell'

export default function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel }: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ModalShell title={title} width={360} onClose={onCancel}>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5 }}>{body}</div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
            borderRadius: 6, padding: '7px 18px', fontSize: 13, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          style={{
            background: danger ? '#c0392b' : 'var(--accent)', border: 'none', color: '#fff',
            borderRadius: 6, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  )
}

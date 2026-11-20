/** Rename a group — every project in it moves with the name. */
import { useState } from 'react'
import ModalShell from './ModalShell'

export default function RenameGroupDialog({ name, onRename, onCancel }: {
  name: string
  onRename: (next: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(name)
  const trimmed = value.trim()
  const changed = !!trimmed && trimmed !== name

  return (
    <ModalShell title={`Rename “${name}”`} width={380} onClose={onCancel}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (changed) onRename(trimmed) }}
        style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
      >
        <input
          autoFocus
          aria-label="Group name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
              borderRadius: 6, padding: '7px 18px', fontSize: 13, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!changed}
            style={{
              background: changed ? 'var(--accent)' : 'var(--bg-elevated)', border: 'none',
              color: changed ? '#fff' : 'var(--text-muted)', borderRadius: 6,
              padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: changed ? 'pointer' : 'default',
            }}
          >
            Rename
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

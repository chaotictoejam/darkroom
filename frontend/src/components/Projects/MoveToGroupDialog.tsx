/** Pick the group a project belongs to: an existing one, a new one, or none. */
import { useState } from 'react'
import type { ProjectGroup } from '../../api/types'
import { sameGroup } from '../../projectGroups'
import ModalShell from './ModalShell'

interface Props {
  projectName: string
  /** The project's current group, "" when ungrouped. */
  current: string
  groups: ProjectGroup[]
  /** Called with the chosen group name; "" removes the project from its group. */
  onMove: (group: string) => void
  onCancel: () => void
}

export default function MoveToGroupDialog({ projectName, current, groups, onMove, onCancel }: Props) {
  const [newGroup, setNewGroup] = useState('')
  const trimmed = newGroup.trim()

  return (
    <ModalShell title={`Group “${projectName}”`} width={400} onClose={onCancel}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
        {groups.map((g) => (
          <GroupRow
            key={g.name}
            label={g.name}
            hint={`${g.count} project${g.count === 1 ? '' : 's'}`}
            selected={!!current && sameGroup(current, g.name)}
            onClick={() => onMove(g.name)}
          />
        ))}
        <GroupRow label="No group" selected={!current} onClick={() => onMove('')} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (trimmed) onMove(trimmed) }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          aria-label="New group name"
          placeholder="New group…"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="submit"
          disabled={!trimmed}
          style={{
            background: trimmed ? 'var(--accent)' : 'var(--bg-elevated)', border: 'none',
            color: trimmed ? '#fff' : 'var(--text-muted)', borderRadius: 6,
            padding: '7px 16px', fontSize: 13, fontWeight: 600,
            cursor: trimmed ? 'pointer' : 'default',
          }}
        >
          Create
        </button>
      </form>

      <button
        onClick={onCancel}
        style={{
          background: 'none', border: 'none', color: 'var(--text-muted)',
          fontSize: 13, cursor: 'pointer', alignSelf: 'center',
        }}
      >
        Cancel
      </button>
    </ModalShell>
  )
}

function GroupRow({ label, hint, selected, onClick }: {
  label: string
  hint?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        background: selected ? 'var(--bg-elevated)' : 'none',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        color: 'var(--text)', borderRadius: 8, padding: '9px 12px',
        fontSize: 13, cursor: 'pointer', textAlign: 'left',
      }}
    >
      <span>{label}</span>
      {hint && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{hint}</span>}
    </button>
  )
}

/** Group filter chips above the project grid, plus actions for the chosen group. */
import type { ProjectGroup } from '../../api/types'
import { ALL_PROJECTS, sameGroup, type GroupFilter } from '../../projectGroups'

interface Props {
  groups: ProjectGroup[]
  total: number
  ungrouped: number
  filter: GroupFilter
  onSelect: (filter: GroupFilter) => void
  onRename: (name: string) => void
  onUngroup: (name: string) => void
}

export default function GroupBar({ groups, total, ungrouped, filter, onSelect, onRename, onUngroup }: Props) {
  const active = filter.kind === 'group' ? filter.name : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div role="tablist" aria-label="Project groups" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Chip
          label="All projects"
          count={total}
          selected={filter.kind === 'all'}
          onClick={() => onSelect(ALL_PROJECTS)}
        />
        {groups.map((g) => (
          <Chip
            key={g.name}
            label={g.name}
            count={g.count}
            selected={!!active && sameGroup(active, g.name)}
            onClick={() => onSelect({ kind: 'group', name: g.name })}
          />
        ))}
        {ungrouped > 0 && groups.length > 0 && (
          <Chip
            label="Ungrouped"
            count={ungrouped}
            selected={filter.kind === 'ungrouped'}
            onClick={() => onSelect({ kind: 'ungrouped' })}
          />
        )}
      </div>

      {active && (
        <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
          <LinkButton onClick={() => onRename(active)}>Rename group</LinkButton>
          <LinkButton onClick={() => onUngroup(active)}>Empty group</LinkButton>
        </div>
      )}
    </div>
  )
}

function Chip({ label, count, selected, onClick }: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      style={{
        background: selected ? 'var(--accent)' : 'var(--bg-card)',
        color: selected ? '#fff' : 'var(--text)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 999, padding: '5px 14px',
        fontSize: 13, fontWeight: selected ? 600 : 500, cursor: 'pointer',
      }}
    >
      {label} <span style={{ opacity: 0.7 }}>{count}</span>
    </button>
  )
}

function LinkButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: 'none', padding: 0,
        color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
      }}
    >
      {children}
    </button>
  )
}

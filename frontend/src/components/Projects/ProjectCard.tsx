/** One project in the Welcome grid. */
import type { ProjectSummary } from '../../api/types'

const STATUS_LABELS: Record<string, string> = {
  created: 'No media yet',
  recording: 'Recording',
  uploaded: 'Ready to transcribe',
  transcribing: 'Transcribing…',
  transcribed: 'Transcribed',
  analyzing: 'Analysing…',
  ready: 'Ready to edit',
  rendering: 'Rendering…',
  error: 'Error',
}

interface Props {
  project: ProjectSummary
  /** Shown as a chip when the grid mixes groups ("All projects"). */
  showGroup?: boolean
  onOpen: () => void
  onMove: () => void
  onDelete: () => void
}

export default function ProjectCard({ project, showGroup, onOpen, onMove, onDelete }: Props) {
  const group = (project.group ?? '').trim()
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${project.name}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: '14px 16px',
        cursor: 'pointer', textAlign: 'left', minHeight: 104,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span aria-hidden style={{ fontSize: 16, lineHeight: '20px' }}>
          {project.project_type === 'podcast' ? '🎙' : '🎬'}
        </span>
        <div style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, lineHeight: '20px' }}>{project.name}</div>
        <button
          aria-label={`Move ${project.name} to a group`}
          title="Move to group"
          onClick={(e) => { e.stopPropagation(); onMove() }}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer', padding: 0 }}
        >
          🗂
        </button>
        <button
          aria-label={`Delete ${project.name}`}
          title="Delete project"
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer', padding: 0 }}
        >
          ✕
        </button>
      </div>

      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 'auto' }}>
        {STATUS_LABELS[project.status] ?? project.status} · {new Date(project.created_at).toLocaleDateString()}
      </div>

      {showGroup && group && (
        <div style={{
          alignSelf: 'flex-start', fontSize: 11, color: 'var(--text-muted)',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 999, padding: '2px 8px',
        }}>
          {group}
        </div>
      )}
    </div>
  )
}

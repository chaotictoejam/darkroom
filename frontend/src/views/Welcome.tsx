import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Project, ProjectSummary } from '../api/types'

interface Props {
  onNewProject: (project: Project) => void
  onOpenProject: (project: Project) => void
}

export default function Welcome({ onNewProject, onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [backendDown, setBackendDown] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      while (!cancelled) {
        try {
          const data = await api.listProjects()
          if (!cancelled) { setProjects(data); setBackendDown(false); setLoading(false) }
          return
        } catch {
          if (!cancelled) setBackendDown(true)
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  async function handleNew() {
    setCreating(true)
    try {
      const proj = await api.createProject('Untitled Project')
      onNewProject(proj)
    } finally {
      setCreating(false)
    }
  }

  async function handleOpen(id: string) {
    const proj = await api.getProject(id)
    onOpenProject(proj)
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    await api.deleteProject(id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 32 }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 48, fontWeight: 700, letterSpacing: -1 }}>
          Dark<span style={{ color: 'var(--accent)' }}>room</span>
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Your footage, developed locally.</p>
      </div>

      <button
        onClick={handleNew}
        disabled={creating}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 'var(--radius)', padding: '12px 28px',
          fontSize: 15, fontWeight: 600,
        }}
      >
        {creating ? 'Creating…' : '+ New Project'}
      </button>

      <div style={{ width: '100%', maxWidth: 480 }}>
        {loading && <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Loading projects…</p>}
        {backendDown && (
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--accent)', borderRadius: 8, padding: '12px 16px', fontSize: 13 }}>
            <strong style={{ color: 'var(--accent)' }}>Backend not running.</strong>
            <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
              Start it with: <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4 }}>make backend</code>
              {' '}or{' '}
              <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4 }}>cd backend && uvicorn darkroom.main:app --reload --port 8000</code>
            </p>
          </div>
        )}
        {!loading && !backendDown && projects.length === 0 && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No projects yet.</p>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            onClick={() => handleOpen(p.id)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-card)', borderRadius: 'var(--radius)',
              padding: '12px 16px', marginBottom: 8, cursor: 'pointer',
              border: '1px solid var(--border)',
            }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>{p.name}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {p.status} · {new Date(p.created_at).toLocaleDateString()}
              </div>
            </div>
            <button
              onClick={(e) => handleDelete(e, p.id)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 16 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

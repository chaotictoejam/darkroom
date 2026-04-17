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
  const [showTypePicker, setShowTypePicker] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

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

  async function handleNew(type: 'video' | 'podcast') {
    setShowTypePicker(false)
    setCreating(true)
    try {
      const proj = await api.createProject('Untitled Project', type)
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
    setConfirmDelete(id)
  }

  async function confirmAndDelete() {
    if (!confirmDelete) return
    await api.deleteProject(confirmDelete)
    setProjects((prev) => prev.filter((p) => p.id !== confirmDelete))
    setConfirmDelete(null)
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
        onClick={() => setShowTypePicker(true)}
        disabled={creating}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 'var(--radius)', padding: '12px 28px',
          fontSize: 15, fontWeight: 600, cursor: 'pointer',
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
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* ── Project type picker modal ────────────────────────────────────── */}
      {showTypePicker && (
        <div
          onClick={() => setShowTypePicker(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 12, padding: '32px 28px', width: 420,
              display: 'flex', flexDirection: 'column', gap: 24,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 6 }}>New project</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>What are you editing?</div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              {([
                { type: 'video',   icon: '🎬', title: 'Video',   desc: 'Interview, talking head, multi-cam footage' },
                { type: 'podcast', icon: '🎙️', title: 'Podcast', desc: 'Audio-only recording, no video' },
              ] as const).map(({ type, icon, title, desc }) => (
                <button
                  key={type}
                  onClick={() => handleNew(type)}
                  style={{
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 10, padding: '20px 12px',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  <span style={{ fontSize: 32 }}>{icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{title}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{desc}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowTypePicker(false)}
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)',
                fontSize: 13, cursor: 'pointer', alignSelf: 'center',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Delete confirmation modal ─────────────────────────────────────── */}
      {confirmDelete && (
        <div
          onClick={() => setConfirmDelete(null)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '28px 32px',
              width: 340,
              display: 'flex', flexDirection: 'column', gap: 20,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Delete project?</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                "{projects.find((p) => p.id === confirmDelete)?.name}" will be permanently deleted.
                This cannot be undone.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  background: 'none', border: '1px solid var(--border)',
                  color: 'var(--text)', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmAndDelete}
                style={{
                  background: '#c0392b', border: 'none',
                  color: '#fff', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

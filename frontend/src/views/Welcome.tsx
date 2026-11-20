import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { Project, ProjectSummary } from '../api/types'
import ConfirmDialog from '../components/Projects/ConfirmDialog'
import GroupBar from '../components/Projects/GroupBar'
import MoveToGroupDialog from '../components/Projects/MoveToGroupDialog'
import ProjectCard from '../components/Projects/ProjectCard'
import RenameGroupDialog from '../components/Projects/RenameGroupDialog'
import {
  ALL_PROJECTS, filterLabel, filterProjects, groupOf, groupsOf, resolveFilter, ungroupedCount, type GroupFilter,
} from '../projectGroups'

interface Props {
  onNewProject: (project: Project) => void
  onOpenProject: (project: Project) => void
}

export default function Welcome({ onNewProject, onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [backendDown, setBackendDown] = useState(false)
  const [creating, setCreating] = useState(false)
  // New project modal: closed, or which step is showing
  const [newStep, setNewStep] = useState<'closed' | 'source' | 'record-kind'>('closed')
  const [newName, setNewName] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Which group the grid shows
  const [filter, setFilter] = useState<GroupFilter>(ALL_PROJECTS)
  // Project id whose group is being changed
  const [moving, setMoving] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [emptyingGroup, setEmptyingGroup] = useState<string | null>(null)

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

  const groups = useMemo(() => groupsOf(projects), [projects])
  const ungrouped = useMemo(() => ungroupedCount(projects), [projects])
  // A group whose last project was deleted or moved away falls back to All
  const shown = useMemo(() => resolveFilter(projects, filter), [projects, filter])
  const visible = useMemo(() => filterProjects(projects, shown), [projects, shown])
  const movingProject = projects.find((p) => p.id === moving)

  function openNew() {
    setNewName('')
    // A group is open: file the new project there by default
    setNewGroup(shown.kind === 'group' ? shown.name : '')
    setNewStep('source')
  }

  async function handleNew(source: 'upload' | 'record') {
    setCreating(true)
    try {
      // Upload works out video vs audio from the files; Record (audio only for now) is a podcast.
      const type = source === 'record' ? 'podcast' : 'video'
      const proj = await api.createProject(newName.trim() || 'Untitled Project', type, source, newGroup.trim())
      setNewStep('closed')
      onNewProject(proj)
    } finally {
      setCreating(false)
    }
  }

  async function handleOpen(id: string) {
    const proj = await api.getProject(id)
    onOpenProject(proj)
  }

  async function confirmAndDelete() {
    if (!confirmDelete) return
    await api.deleteProject(confirmDelete)
    setProjects((prev) => prev.filter((p) => p.id !== confirmDelete))
    setConfirmDelete(null)
  }

  async function moveToGroup(group: string) {
    if (!moving) return
    const id = moving
    setMoving(null)
    await api.patchProject(id, { group })
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, group } : p)))
  }

  async function renameGroup(next: string) {
    const old = renamingGroup
    if (!old) return
    setRenamingGroup(null)
    await api.renameGroup(old, next)
    setProjects(await api.listProjects())
    setFilter(next ? { kind: 'group', name: next } : ALL_PROJECTS)
  }

  async function emptyGroup() {
    const name = emptyingGroup
    if (!name) return
    setEmptyingGroup(null)
    await api.ungroupGroup(name)
    setProjects(await api.listProjects())
    setFilter(ALL_PROJECTS)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      minHeight: '100vh', gap: 28, padding: '56px 24px 64px',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 48, fontWeight: 700, letterSpacing: -1 }}>
          Dark<span style={{ color: 'var(--accent)' }}>room</span>
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Your footage, developed locally.</p>
      </div>

      <button
        onClick={openNew}
        disabled={creating}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 'var(--radius)', padding: '12px 28px',
          fontSize: 15, fontWeight: 600, cursor: 'pointer',
        }}
      >
        {creating ? 'Creating…' : '+ New Project'}
      </button>

      <div style={{ width: '100%', maxWidth: 1040, display: 'flex', flexDirection: 'column', gap: 16 }}>
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

        {projects.length > 0 && (
          <>
            {groups.length > 0 && (
              <GroupBar
                groups={groups}
                total={projects.length}
                ungrouped={ungrouped}
                filter={shown}
                onSelect={setFilter}
                onRename={setRenamingGroup}
                onUngroup={setEmptyingGroup}
              />
            )}

            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>{filterLabel(shown)}</h2>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {visible.length} project{visible.length === 1 ? '' : 's'}
              </span>
            </div>

            <div style={{
              display: 'grid', gap: 12,
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            }}>
              {visible.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  showGroup={shown.kind === 'all'}
                  onOpen={() => { void handleOpen(p.id) }}
                  onMove={() => setMoving(p.id)}
                  onDelete={() => setConfirmDelete(p.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── New project modal: name, group, then Upload or Record ──────────── */}
      {newStep !== 'closed' && (
        <div
          onClick={() => setNewStep('closed')}
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
              borderRadius: 12, padding: '32px 28px',
              width: 'min(440px, calc(100vw - 32px))',
              display: 'flex', flexDirection: 'column', gap: 20,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 17 }}>
              {newStep === 'source' ? 'New project' : 'What are you recording?'}
            </div>

            {newStep === 'source' ? (
              <>
                <label>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Name</span>
                  <input
                    autoFocus
                    value={newName}
                    placeholder="Untitled Project"
                    onChange={(e) => setNewName(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>
                    Group <span style={{ opacity: 0.7 }}>(optional)</span>
                  </span>
                  <input
                    value={newGroup}
                    placeholder="e.g. chaoticcommits"
                    list="darkroom-groups"
                    onChange={(e) => setNewGroup(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <datalist id="darkroom-groups">
                    {groups.map((g) => <option key={g.name} value={g.name} />)}
                  </datalist>
                </label>
                <div style={{ display: 'flex', gap: 12 }}>
                  <ChoiceCard icon="⬆" title="Upload" desc="Files that are already synced" disabled={creating} onClick={() => { void handleNew('upload') }} />
                  <ChoiceCard icon="●" title="Record" desc="Record each participant's microphone" disabled={creating} onClick={() => setNewStep('record-kind')} />
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 12 }}>
                <ChoiceCard icon="🎙" title="Audio only" desc="A podcast, one track per microphone" disabled={creating} onClick={() => { void handleNew('record') }} />
                <ChoiceCard icon="🎬" title="Video + audio" desc="Cameras and screens: coming soon" disabled onClick={() => {}} />
              </div>
            )}

            <button
              onClick={() => (newStep === 'record-kind' ? setNewStep('source') : setNewStep('closed'))}
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)',
                fontSize: 13, cursor: 'pointer', alignSelf: 'center',
              }}
            >
              {newStep === 'record-kind' ? '← Back' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {movingProject && (
        <MoveToGroupDialog
          projectName={movingProject.name}
          current={groupOf(movingProject)}
          groups={groups}
          onMove={(group) => { void moveToGroup(group) }}
          onCancel={() => setMoving(null)}
        />
      )}

      {renamingGroup && (
        <RenameGroupDialog
          name={renamingGroup}
          onRename={(next) => { void renameGroup(next) }}
          onCancel={() => setRenamingGroup(null)}
        />
      )}

      {emptyingGroup && (
        <ConfirmDialog
          title="Empty group?"
          body={`Projects in “${emptyingGroup}” will be ungrouped. Nothing is deleted.`}
          confirmLabel="Empty group"
          onConfirm={() => { void emptyGroup() }}
          onCancel={() => setEmptyingGroup(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete project?"
          body={`"${projects.find((p) => p.id === confirmDelete)?.name}" will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { void confirmAndDelete() }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

function ChoiceCard({ icon, title, desc, disabled, onClick }: {
  icon: string
  title: string
  desc: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 10, padding: '20px 12px',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 10, cursor: disabled ? 'default' : 'pointer', textAlign: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = 'var(--accent)' }}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <span style={{ fontSize: 28, color: 'var(--accent)' }}>{icon}</span>
      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{title}</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{desc}</span>
    </button>
  )
}

/**
 * Editor header project name: click to rename (saved on blur or Enter, Escape reverts).
 */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Project } from '../../api/types'

export default function ProjectName({ project, onRenamed }: { project: Project; onRenamed: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (!editing) setName(project.name) }, [project.name, editing])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  async function commit() {
    const trimmed = name.trim()
    setEditing(false)
    if (!trimmed || trimmed === project.name) {
      setName(project.name)
      return
    }
    setSaving(true)
    setError(null)
    try {
      // Only take the name: the rest of the response may predate pending cut saves
      const saved = await api.patchProject(project.id, { name: trimmed })
      onRenamed(saved.name)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not rename the project')
      setName(project.name)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setName(project.name)
            setEditing(false)
          }
        }}
        aria-label="Project name"
        style={{ fontWeight: 600, fontSize: 14, width: 280, padding: '3px 6px', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--text)' }}
      />
    )
  }

  return (
    <>
      <button
        onClick={() => setEditing(true)}
        disabled={saving}
        title="Rename project"
        style={{
          background: 'none', border: '1px solid transparent', borderRadius: 4,
          color: 'var(--text)', fontWeight: 600, fontSize: 14, padding: '3px 6px',
          cursor: 'text', opacity: saving ? 0.6 : 1,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent' }}
      >
        {name}
      </button>
      {error && <span style={{ fontSize: 12, color: '#f55' }}>{error}</span>}
    </>
  )
}

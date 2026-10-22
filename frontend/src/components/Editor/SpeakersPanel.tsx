/**
 * Sidebar speaker names: rename a speaker (saved on blur or Enter, Escape reverts).
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Project } from '../../api/types'

const savedNames = (project: Project) => Object.fromEntries(project.speakers.map((s) => [s.id, s.name]))

export default function SpeakersPanel({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [names, setNames] = useState<Record<string, string>>(() => savedNames(project))
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Pick up names saved elsewhere (the whole project is replaced after a rename)
  useEffect(() => setNames(savedNames(project)), [project.speakers])

  async function commit(speakerId: string) {
    const name = (names[speakerId] ?? '').trim()
    const current = project.speakers.find((s) => s.id === speakerId)
    if (!current || !name || name === current.name) {
      setNames((prev) => ({ ...prev, [speakerId]: current?.name ?? '' }))
      return
    }
    setSavingId(speakerId)
    setError(null)
    try {
      onChange(await api.renameSpeaker(project.id, speakerId, name))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not rename the speaker')
      setNames((prev) => ({ ...prev, [speakerId]: current.name }))
    } finally {
      setSavingId(null)
    }
  }

  if (project.speakers.length === 0) {
    return <p style={{ padding: 14, margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>No speakers yet.</p>
  }

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {project.speakers.map((s) => (
        <label key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {project.project_type === 'podcast' ? 'Track' : 'Camera'} {s.id}
          </span>
          <input
            value={names[s.id] ?? ''}
            maxLength={60}
            onChange={(e) => setNames((prev) => ({ ...prev, [s.id]: e.target.value }))}
            onBlur={() => commit(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setNames((prev) => ({ ...prev, [s.id]: s.name }))
                // Blur after the revert lands so commit() sees the saved name
                const input = e.currentTarget
                setTimeout(() => input.blur())
              }
            }}
            disabled={savingId === s.id}
            style={{ fontSize: 13, width: '100%' }}
          />
        </label>
      ))}
      {error && <p style={{ margin: 0, fontSize: 12, color: '#f55' }}>{error}</p>}
    </div>
  )
}

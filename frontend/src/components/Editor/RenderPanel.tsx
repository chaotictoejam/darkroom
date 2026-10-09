/**
 * Sidebar render controls: start a render, follow it, and download the results.
 */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, subscribeToProgress } from '../../api/client'
import type { Project } from '../../api/types'

export default function RenderPanel({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [starting, setStarting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [renderedAt, setRenderedAt] = useState(0)
  const unsubRef = useRef<(() => void) | null>(null)
  const isAudio = project.project_type === 'podcast'
  const rendering = starting || project.status === 'rendering'

  useEffect(() => () => unsubRef.current?.(), [])

  /** Follow a running render, then reload the project so its new files show up. */
  function watchRender() {
    unsubRef.current?.()
    unsubRef.current = subscribeToProgress(project.id, async (evt) => {
      if (evt.progress?.message) setMessage(evt.progress.message)
      if (evt.status !== 'ready' && evt.status !== 'error') return
      unsubRef.current?.()
      unsubRef.current = null
      onChange(await api.getProject(project.id))
      // Same filenames as last time: make the download links fetch the new files
      setRenderedAt(Date.now())
    })
  }

  async function handleRender(target: string) {
    setStarting(true)
    setMessage(null)
    try {
      await api.render(project.id, [target])
      onChange({ ...project, status: 'rendering' })
      watchRender()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMessage('A render is already running; export again when it finishes.')
        watchRender()
      } else {
        setMessage(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setStarting(false)
    }
  }

  const buttonStyle = {
    background: 'var(--accent)', color: '#fff', border: 'none',
    borderRadius: 6, padding: '8px 16px', fontWeight: 600, fontSize: 13,
    cursor: project.edl && !rendering ? 'pointer' : 'default',
    opacity: project.edl ? 1 : 0.5,
  }

  return (
    <div style={{ padding: 14 }}>
      {!project.edl && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12, marginTop: 0 }}>
          Run AI analysis first to generate an EDL.
        </p>
      )}
      {isAudio ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => handleRender('mp3')} disabled={!project.edl || rendering} style={buttonStyle}>
            {rendering ? 'Rendering…' : 'Export MP3'}
          </button>
          <button
            onClick={() => handleRender('wav')}
            disabled={!project.edl || rendering}
            title="Lossless master"
            style={{ ...buttonStyle, background: 'none', border: '1px solid var(--accent)', color: 'var(--accent)' }}
          >
            Export WAV
          </button>
        </div>
      ) : (
        <button onClick={() => handleRender('fullEdit')} disabled={!project.edl || rendering} style={buttonStyle}>
          {rendering ? 'Rendering…' : 'Render Full Edit'}
        </button>
      )}

      {message && (
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '10px 0 0' }}>{message}</p>
      )}

      {Object.entries(project.renders).map(([name, render]) => (
        <div key={name} style={{ marginTop: 10, padding: 10, background: 'var(--bg-card)', borderRadius: 6 }}>
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{render.filename}</div>
          <a href={renderedAt ? `${render.url}?t=${renderedAt}` : render.url} download style={{ color: 'var(--accent)', fontSize: 12 }}>
            Download
          </a>
        </div>
      ))}
    </div>
  )
}

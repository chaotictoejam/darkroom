/**
 * Sidebar DarkRelay controls: episode details, the bundle export, and how to publish it.
 * The bundle is written on this computer; the DarkRelay CLI uploads it to the user's own AWS account.
 */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, subscribeToProgress } from '../../api/client'
import type { Project } from '../../api/types'
import type { TimeRange } from '../Timeline/timeMap'
import PublishDialog, { formatTime } from './PublishDialog'

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Quote a path for a POSIX or Windows shell. */
function shellQuote(path: string): string {
  return /^[\w./:\\-]+$/.test(path) ? path : `"${path.replace(/"/g, '\\"')}"`
}

export default function PublishPanel({
  project,
  keptRanges,
  currentTime,
  onChange,
}: {
  project: Project
  keptRanges: TimeRange[]
  currentTime: number
  onChange: (p: Project) => void
}) {
  const [editing, setEditing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const unsubRef = useRef<(() => void) | null>(null)
  const details = project.publish
  const bundle = details.bundle
  const busy = starting || project.status === 'rendering'
  const ready = !!project.edl && SLUG.test(details.show) && !!details.title.trim() && !!details.notes.trim()

  useEffect(() => () => unsubRef.current?.(), [])

  function watch() {
    unsubRef.current?.()
    unsubRef.current = subscribeToProgress(project.id, async (evt) => {
      if (evt.progress?.message) setMessage(evt.progress.message)
      if (evt.status !== 'ready' && evt.status !== 'error') return
      unsubRef.current?.()
      unsubRef.current = null
      onChange(await api.getProject(project.id))
    })
  }

  async function exportBundle() {
    setStarting(true)
    setMessage(null)
    try {
      await api.exportBundle(project.id)
      onChange({ ...project, status: 'rendering' })
      watch()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMessage('A render is already running; export again when it finishes.')
        watch()
      } else {
        setMessage(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setStarting(false)
    }
  }

  const command = bundle ? `npx darkrelay publish ${shellQuote(bundle.dir)} --show ${details.show}` : ''

  async function copyCommand() {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const muted = { color: 'var(--text-muted)', fontSize: 12, margin: 0, lineHeight: 1.5 } as const

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={muted}>
        Export an episode bundle for{' '}
        <a href="https://github.com/chaotictoejam/darkrelay" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          DarkRelay
        </a>
        : audio, transcript and chapters timed to the edit, plus the episode details.
      </p>

      <div style={{ fontSize: 13 }}>
        {details.title ? (
          <>
            <div style={{ fontWeight: 500 }}>{details.title}</div>
            <div style={muted}>
              {details.show || 'No show set'}
              {details.season ? ` · S${details.season}` : ''}
              {details.episode ? ` · E${details.episode}` : ''}
              {details.chapters.length ? ` · ${details.chapters.length} chapter${details.chapters.length === 1 ? '' : 's'}` : ''}
            </div>
          </>
        ) : (
          <div style={muted}>No episode details yet.</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => setEditing(true)}
          style={{
            background: 'none', border: '1px solid var(--accent)', color: 'var(--accent)',
            borderRadius: 6, padding: '7px 12px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          Details…
        </button>
        <button
          onClick={exportBundle}
          disabled={!ready || busy}
          title={!project.edl ? 'Run AI analysis first' : !ready ? 'Fill in show, title and notes first' : undefined}
          style={{
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
            padding: '7px 12px', fontWeight: 600, fontSize: 13,
            cursor: ready && !busy ? 'pointer' : 'default', opacity: ready ? 1 : 0.5, whiteSpace: 'nowrap',
          }}
        >
          {busy ? 'Exporting…' : 'Export bundle'}
        </button>
      </div>

      {message && <p style={{ ...muted, whiteSpace: 'pre-wrap' }}>{message}</p>}

      {bundle && !busy && (
        <div style={{ padding: 10, background: 'var(--bg-card)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>Bundle · {formatTime(bundle.duration)}</div>
          <div style={muted}>{bundle.files.join(', ')}</div>
          {bundle.warnings.map((w) => (
            <div key={w} style={{ fontSize: 12, color: '#e8a33d' }}>⚠ {w}</div>
          ))}
          <a href={`${bundle.url}?t=${encodeURIComponent(bundle.created_at)}`} download style={{ color: 'var(--accent)', fontSize: 12 }}>
            Download zip
          </a>
          <div style={muted}>Publish it to your own AWS account with the DarkRelay CLI:</div>
          <code style={{ fontSize: 11, wordBreak: 'break-all', background: 'var(--bg)', padding: 6, borderRadius: 4 }}>
            {command}
          </code>
          <button
            onClick={copyCommand}
            style={{
              alignSelf: 'flex-start', background: 'none', border: '1px solid var(--border)',
              color: 'var(--text)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>
        </div>
      )}

      {editing && (
        <PublishDialog
          project={project}
          keptRanges={keptRanges}
          currentTime={currentTime}
          onChange={onChange}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

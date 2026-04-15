/**
 * Editor view — the main workspace.
 *
 * This is a scaffold. The existing editor functionality from index.html
 * will be ported here component by component:
 *   - TranscriptPanel   (inline editing, word-level timestamps)
 *   - EDLPanel          (segment list, keep/cut toggles)
 *   - ShortsBuilder     (clip selection, subtitle options, export)
 *   - VideoPreview      (playback with crop preview)
 *   - RenderPanel       (render targets, download links)
 *
 * Each panel lives in src/components/<Panel>/<Panel>.tsx
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Project, WordCut } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'

interface Props {
  project: Project
  onChange: (project: Project) => void
  onBack: () => void
}

type EditorTab = 'transcript' | 'edl' | 'shorts' | 'render'

export default function Editor({ project, onChange, onBack }: Props) {
  const [tab, setTab] = useState<EditorTab>('transcript')
  const [analyzing, setAnalyzing] = useState(false)
  const [anthropicConfigured, setAnthropicConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    api.status().then((s) => setAnthropicConfigured(s.anthropic_configured))
  }, [])

  async function handleAnalyze() {
    setAnalyzing(true)
    await api.analyze(project.id)
    onChange({ ...project, status: 'analyzing' })
  }

  const tabs: { id: EditorTab; label: string }[] = [
    { id: 'transcript', label: 'Transcript' },
    { id: 'edl',        label: 'Edit Decision List' },
    { id: 'shorts',     label: 'Shorts Builder' },
    { id: 'render',     label: 'Render' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '0 20px', height: 52, background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18 }}>←</button>
        <span style={{ fontWeight: 600 }}>{project.name}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {project.status}</span>

        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: tab === t.id ? 'var(--accent)' : 'none',
                color: tab === t.id ? '#fff' : 'var(--text-muted)',
                border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main area */}
      <main style={{ flex: 1, overflow: tab === 'transcript' ? 'hidden' : 'auto', padding: 24, display: 'flex', flexDirection: 'column' }}>
        {tab === 'transcript' && (
          <TranscriptTab
            project={project}
            onChange={onChange}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
            anthropicConfigured={anthropicConfigured ?? false}
          />
        )}
        {tab === 'edl' && (
          <EDLTab project={project} onChange={onChange} />
        )}
        {tab === 'shorts' && (
          <div style={{ color: 'var(--text-muted)' }}>Shorts Builder — coming soon</div>
        )}
        {tab === 'render' && (
          <RenderTab project={project} onChange={onChange} />
        )}
      </main>
    </div>
  )
}

// ── Transcript tab — split panel: video left, transcript right ────────────────

function TranscriptTab({
  project,
  onChange,
  onAnalyze,
  analyzing,
  anthropicConfigured,
}: {
  project: Project
  onChange: (p: Project) => void
  onAnalyze: () => void
  analyzing: boolean
  anthropicConfigured: boolean
}) {
  const hasEdl = !!project.edl
  const videoRef = useRef<VideoPreviewHandle>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Primary camera — first speaker's file
  const primarySpeaker = project.speakers[0]
  const videoSrc = primarySpeaker
    ? `/projects/${project.id}/files/${primarySpeaker.file}`
    : null

  const wordCuts: WordCut[] = project.word_cuts ?? []

  const handleCutsChange = useCallback(
    (newCuts: WordCut[]) => {
      // Optimistic update
      onChange({ ...project, word_cuts: newCuts })
      // Debounce persist to backend — 600 ms after last change
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        api.saveWordCuts(project.id, newCuts)
      }, 600)
    },
    [project, onChange],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {project.merged_transcript.length} segments
          {wordCuts.length > 0 && ` · ${wordCuts.length} cut${wordCuts.length !== 1 ? 's' : ''}`}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {!hasEdl && (
            anthropicConfigured ? (
              <button
                onClick={onAnalyze}
                disabled={analyzing}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', fontWeight: 600, fontSize: 13 }}
              >
                {analyzing ? 'Analyzing…' : 'Analyze with AI →'}
              </button>
            ) : (
              <span style={{ color: 'var(--text-muted)', fontSize: 12, alignSelf: 'center' }}>
                No API key — use manual flow ↓
              </span>
            )
          )}
        </div>
      </div>

      {/* Split panel */}
      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        {/* Left: video + manual analysis */}
        <div style={{ width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {videoSrc ? (
            <VideoPreview
              ref={videoRef}
              src={videoSrc}
              wordCuts={wordCuts}
              edlSegments={project.edl?.segments ?? []}
              onTimeUpdate={setCurrentTime}
            />
          ) : (
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No video uploaded
            </div>
          )}

          {!hasEdl && (
            <ManualAnalysis project={project} onChange={onChange} highlight={!anthropicConfigured} />
          )}
        </div>

        {/* Right: transcript editor */}
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
          {project.merged_transcript.length > 0 ? (
            <TranscriptEditor
              segments={project.merged_transcript}
              wordCuts={wordCuts}
              currentTime={currentTime}
              onSeek={(t) => videoRef.current?.seekTo(t)}
              onCutsChange={handleCutsChange}
            />
          ) : (
            <p style={{ color: 'var(--text-muted)' }}>No transcript yet.</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Manual analysis fallback ───────────────────────────────────────────────────

function ManualAnalysis({
  project,
  onChange,
  highlight,
}: {
  project: Project
  onChange: (p: Project) => void
  highlight: boolean
}) {
  const [open, setOpen] = useState(highlight)
  const [copied, setCopied] = useState(false)
  const [edlInput, setEdlInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  async function handleCopy() {
    const { prompt } = await api.getPrompt(project.id)
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleImport() {
    setImportError(null)
    setImporting(true)
    try {
      const edl = JSON.parse(edlInput)
      const updated = await api.importEdl(project.id, edl)
      onChange(updated)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Invalid JSON')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div style={{
      marginBottom: 24, borderRadius: 8, overflow: 'hidden',
      border: `1px solid ${highlight ? 'var(--accent)' : 'var(--border)'}`,
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', textAlign: 'left', background: 'var(--bg-elevated)',
          border: 'none', padding: '10px 14px', fontWeight: 500,
          color: highlight ? 'var(--accent)' : 'var(--text-muted)',
          display: 'flex', justifyContent: 'space-between',
        }}
      >
        <span>Manual analysis (paste EDL from Claude)</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            1. Copy the prompt below and paste it into{' '}
            <strong>Claude.ai</strong> or <strong>Claude Code</strong>.<br />
            2. Paste the JSON response back here and click Import.
          </p>
          <button
            onClick={handleCopy}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 14px', fontWeight: 500, alignSelf: 'flex-start' }}
          >
            {copied ? '✓ Copied!' : 'Copy prompt to clipboard'}
          </button>
          <textarea
            value={edlInput}
            onChange={(e) => setEdlInput(e.target.value)}
            placeholder='Paste the EDL JSON from Claude here…'
            rows={6}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}
          />
          {importError && <p style={{ color: '#f55', fontSize: 13 }}>{importError}</p>}
          <button
            onClick={handleImport}
            disabled={!edlInput.trim() || importing}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontWeight: 600, alignSelf: 'flex-start' }}
          >
            {importing ? 'Importing…' : 'Import EDL'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── EDL tab ────────────────────────────────────────────────────────────────────

function EDLTab({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  if (!project.edl) {
    return <p style={{ color: 'var(--text-muted)' }}>No EDL yet — run AI analysis from the Transcript tab.</p>
  }

  const segs = project.edl.segments
  const kept = segs.filter((s) => s.keep).length

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <h3 style={{ fontWeight: 600, marginBottom: 16 }}>{segs.length} segments · {kept} kept</h3>
      {segs.map((seg) => (
        <div
          key={seg.id}
          style={{
            display: 'flex', gap: 12, alignItems: 'center',
            padding: '6px 10px', borderRadius: 6, marginBottom: 4,
            background: seg.keep ? 'var(--bg-elevated)' : 'transparent',
            opacity: seg.keep ? 1 : 0.4,
            border: '1px solid var(--border)',
          }}
        >
          <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 120, flexShrink: 0 }}>
            {fmt(seg.start)} → {fmt(seg.end)}
          </span>
          <span style={{ color: 'var(--accent)', fontSize: 12, width: 24, flexShrink: 0 }}>
            {seg.camera}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>
            {seg.layout} · {seg.reason ?? '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Render tab ─────────────────────────────────────────────────────────────────

function RenderTab({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [rendering, setRendering] = useState(false)

  async function handleRender() {
    setRendering(true)
    try {
      await api.render(project.id, ['fullEdit'])
      onChange({ ...project, status: 'rendering' })
    } finally {
      setRendering(false)
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Render</h3>

      {!project.edl && (
        <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>Run AI analysis first to generate an EDL.</p>
      )}

      <button
        onClick={handleRender}
        disabled={!project.edl || rendering}
        style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 20px', fontWeight: 600 }}
      >
        {rendering ? 'Rendering…' : 'Render Full Edit'}
      </button>

      {Object.entries(project.renders).map(([name, render]) => (
        <div key={name} style={{ marginTop: 16, padding: 12, background: 'var(--bg-elevated)', borderRadius: 8 }}>
          <div style={{ fontWeight: 500 }}>{render.filename}</div>
          <a href={render.url} download style={{ color: 'var(--accent)', fontSize: 13 }}>
            Download
          </a>
        </div>
      ))}
    </div>
  )
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}

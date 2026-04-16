/**
 * Editor view — the main workspace.
 *
 * Layout:
 *   [Header: back · name · status · analyze btn]
 *   ┌──────────┬──────────────────────┬──────────────────┐
 *   │ Sidebar  │ Transcript           │ Preview          │
 *   │ [EDL]    │ (inline edits)       │ [Multi / Solo]   │
 *   │ [Shorts] │                      │ [video player]   │
 *   │ [Render] ├──────────────────────┴──────────────────┤
 *   │ [Manual] │ Timeline / Tracker                      │
 *   └──────────┴─────────────────────────────────────────┘
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { EDLSegment, Project, WordCut } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'

interface Props {
  project: Project
  onChange: (project: Project) => void
  onBack: () => void
}

type SidePanel = 'shorts' | 'render' | 'manual'
type PreviewLayout = 'multi' | 'solo'

export default function Editor({ project, onChange, onBack }: Props) {
  const [analyzing, setAnalyzing] = useState(false)
  const [anthropicConfigured, setAnthropicConfigured] = useState<boolean | null>(null)
  const [openPanels, setOpenPanels] = useState<Set<SidePanel>>(new Set())
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout>('multi')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const videoRef = useRef<VideoPreviewHandle>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.status().then((s) => {
      setAnthropicConfigured(s.anthropic_configured)
      // Auto-open manual analysis panel when no API key
      if (!s.anthropic_configured && !project.edl) {
        setOpenPanels((prev) => new Set([...prev, 'manual']))
      }
    })
  }, [])

  async function handleAnalyze() {
    setAnalyzing(true)
    await api.analyze(project.id)
    onChange({ ...project, status: 'analyzing' })
  }

  function togglePanel(panel: SidePanel) {
    setOpenPanels((prev) => {
      const next = new Set(prev)
      if (next.has(panel)) next.delete(panel)
      else next.add(panel)
      return next
    })
  }

  const primarySpeaker = project.speakers[0]
  const videoSrc = primarySpeaker
    ? `/projects/${project.id}/files/${primarySpeaker.file}`
    : null

  const wordCuts: WordCut[] = project.word_cuts ?? []
  const hasEdl = !!project.edl

  const handleCutsChange = useCallback(
    (newCuts: WordCut[]) => {
      onChange({ ...project, word_cuts: newCuts })
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        api.saveWordCuts(project.id, newCuts)
      }, 600)
    },
    [project, onChange],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 16px', height: 48, flexShrink: 0,
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border)',
      }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '0 4px' }}
        >
          ←
        </button>
        <span style={{ fontWeight: 600 }}>{project.name}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {project.status}</span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {!hasEdl && anthropicConfigured === true && (
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              style={{
                background: 'var(--accent)', color: '#fff', border: 'none',
                borderRadius: 6, padding: '5px 14px', fontWeight: 600, fontSize: 13,
                cursor: analyzing ? 'default' : 'pointer',
              }}
            >
              {analyzing ? 'Analyzing…' : 'Analyze with AI →'}
            </button>
          )}
          {!hasEdl && anthropicConfigured === false && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              No API key — use Manual Analysis in the sidebar
            </span>
          )}
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* ── Left Sidebar ─────────────────────────────────────────────────── */}
        <aside style={{
          width: 260, flexShrink: 0,
          background: 'var(--bg-elevated)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto',
        }}>
          <SidebarSection
            label="Shorts Builder"
            open={openPanels.has('shorts')}
            onToggle={() => togglePanel('shorts')}
          >
            <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: 13 }}>
              Shorts Builder — coming soon
            </div>
          </SidebarSection>

          {!hasEdl && (
            <SidebarSection
              label="Manual Analysis"
              open={openPanels.has('manual')}
              onToggle={() => togglePanel('manual')}
            >
              <ManualAnalysis
                project={project}
                onChange={onChange}
                highlight={anthropicConfigured === false}
              />
            </SidebarSection>
          )}

          <SidebarSection
            label="Render"
            open={openPanels.has('render')}
            onToggle={() => togglePanel('render')}
          >
            <RenderContent project={project} onChange={onChange} />
          </SidebarSection>
        </aside>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

          {/* Top row: Transcript | Preview */}
          <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

            {/* Transcript */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
              <div style={{
                padding: '6px 16px', flexShrink: 0,
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-elevated)',
                fontSize: 12, color: 'var(--text-muted)',
              }}>
                {project.merged_transcript.length} segments
                {wordCuts.length > 0 && ` · ${wordCuts.length} cut${wordCuts.length !== 1 ? 's' : ''}`}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
                {project.merged_transcript.length > 0 ? (
                  <TranscriptEditor
                    segments={project.merged_transcript}
                    wordCuts={wordCuts}
                    edlSegments={project.edl?.segments ?? []}
                    currentTime={currentTime}
                    onSeek={(t) => videoRef.current?.seekTo(t)}
                    onCutsChange={handleCutsChange}
                  />
                ) : (
                  <p style={{ color: 'var(--text-muted)' }}>No transcript yet.</p>
                )}
              </div>
            </div>

            {/* Preview */}
            <div style={{
              width: 380, flexShrink: 0,
              borderLeft: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column',
              background: 'var(--bg-elevated)',
            }}>
              {/* Layout selector */}
              <div style={{
                display: 'flex', gap: 4, padding: '6px 10px', flexShrink: 0,
                borderBottom: '1px solid var(--border)',
              }}>
                {(['multi', 'solo'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setPreviewLayout(mode)}
                    style={{
                      flex: 1,
                      background: previewLayout === mode ? 'var(--accent)' : 'var(--bg-card)',
                      color: previewLayout === mode ? '#fff' : 'var(--text-muted)',
                      border: `1px solid ${previewLayout === mode ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 6, padding: '4px 8px', fontSize: 12,
                      cursor: 'pointer', fontWeight: previewLayout === mode ? 600 : 400,
                    }}
                  >
                    {mode === 'multi' ? 'Multi Speaker' : 'Solo Speaker'}
                  </button>
                ))}
              </div>

              {/* Video player */}
              <div style={{ flex: 1, overflow: 'hidden', padding: 8, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                {videoSrc ? (
                  <VideoPreview
                    ref={videoRef}
                    src={videoSrc}
                    wordCuts={wordCuts}
                    edlSegments={project.edl?.segments ?? []}
                    onTimeUpdate={setCurrentTime}
                    onDurationChange={setDuration}
                  />
                ) : (
                  <div style={{
                    width: '100%', background: 'var(--bg-card)', borderRadius: 8,
                    height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-muted)', fontSize: 13,
                  }}>
                    No video uploaded
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Timeline / Tracker ──────────────────────────────────────────── */}
          <Timeline
            duration={duration}
            currentTime={currentTime}
            wordCuts={wordCuts}
            edlSegments={project.edl?.segments ?? []}
            onSeek={(t) => videoRef.current?.seekTo(t)}
          />
        </div>
      </div>
    </div>
  )
}

// ── Sidebar section ────────────────────────────────────────────────────────────

function SidebarSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', background: 'none', border: 'none',
          color: open ? 'var(--text)' : 'var(--text-muted)',
          fontSize: 13, fontWeight: open ? 600 : 400,
          cursor: 'pointer', textAlign: 'left',
          transition: 'color 0.1s',
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', maxHeight: 420, overflowY: 'auto' }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ── Render content (sidebar) ───────────────────────────────────────────────────

function RenderContent({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
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
    <div style={{ padding: 14 }}>
      {!project.edl && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12, marginTop: 0 }}>
          Run AI analysis first to generate an EDL.
        </p>
      )}
      <button
        onClick={handleRender}
        disabled={!project.edl || rendering}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 6, padding: '8px 16px', fontWeight: 600, fontSize: 13,
          cursor: project.edl && !rendering ? 'pointer' : 'default',
          opacity: project.edl ? 1 : 0.5,
        }}
      >
        {rendering ? 'Rendering…' : 'Render Full Edit'}
      </button>

      {Object.entries(project.renders).map(([name, render]) => (
        <div key={name} style={{ marginTop: 10, padding: 10, background: 'var(--bg-card)', borderRadius: 6 }}>
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{render.filename}</div>
          <a href={render.url} download style={{ color: 'var(--accent)', fontSize: 12 }}>
            Download
          </a>
        </div>
      ))}
    </div>
  )
}

// ── Timeline / Tracker ─────────────────────────────────────────────────────────

function Timeline({
  duration,
  currentTime,
  wordCuts,
  edlSegments,
  onSeek,
}: {
  duration: number
  currentTime: number
  wordCuts: WordCut[]
  edlSegments: EDLSegment[]
  onSeek: (t: number) => void
}) {
  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (duration === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - rect.left) / rect.width) * duration)
  }

  return (
    <div style={{
      height: 84, flexShrink: 0,
      background: 'var(--bg-elevated)',
      borderTop: '1px solid var(--border)',
      padding: '8px 16px',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      {/* Labels row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
          TIMELINE
        </span>
        <span style={{ fontSize: 11, color: 'var(--border)', fontStyle: 'italic' }}>
          Smart segments — coming soon
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {duration > 0 ? `${fmt(currentTime)} / ${fmt(duration)}` : '--:-- / --:--'}
        </span>
      </div>

      {/* Track */}
      <div
        onClick={handleClick}
        style={{
          flex: 1, position: 'relative',
          background: 'var(--bg-card)',
          borderRadius: 4, overflow: 'hidden',
          cursor: duration > 0 ? 'pointer' : 'default',
          border: '1px solid var(--border)',
        }}
      >
        {duration > 0 ? (
          <>
            {/* EDL segment shading */}
            {edlSegments.map((seg) => (
              <div
                key={seg.id}
                style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: `${(seg.start / duration) * 100}%`,
                  width: `${((seg.end - seg.start) / duration) * 100}%`,
                  background: seg.keep
                    ? 'rgba(50, 180, 100, 0.22)'
                    : 'rgba(200, 50, 50, 0.18)',
                }}
              />
            ))}

            {/* Word cuts */}
            {wordCuts.map((cut, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute', top: '20%', bottom: '20%',
                  left: `${(cut.start / duration) * 100}%`,
                  width: `${Math.max(0.25, ((cut.end - cut.start) / duration) * 100)}%`,
                  background: 'rgba(229, 51, 51, 0.75)',
                  borderRadius: 1,
                }}
              />
            ))}

            {/* Playhead */}
            <div
              style={{
                position: 'absolute', top: 0, bottom: 0,
                left: `${(currentTime / duration) * 100}%`,
                width: 2, background: 'var(--accent)',
                transform: 'translateX(-50%)',
                pointerEvents: 'none',
                boxShadow: '0 0 4px var(--accent)',
              }}
            />
          </>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-muted)', fontSize: 12,
          }}>
            Load a video to see the timeline
          </div>
        )}
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
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
        1. Copy the prompt and paste it into <strong style={{ color: highlight ? 'var(--accent)' : 'inherit' }}>Claude.ai</strong>.<br />
        2. Paste the JSON response back here and click Import.
      </p>
      <button
        onClick={handleCopy}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          color: 'var(--text)', borderRadius: 6, padding: '6px 12px',
          fontWeight: 500, fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start',
        }}
      >
        {copied ? '✓ Copied!' : 'Copy prompt to clipboard'}
      </button>
      <textarea
        value={edlInput}
        onChange={(e) => setEdlInput(e.target.value)}
        placeholder="Paste the EDL JSON from Claude here…"
        rows={5}
        style={{
          resize: 'vertical', fontFamily: 'monospace', fontSize: 11,
          background: 'var(--bg-card)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6, padding: 8,
        }}
      />
      {importError && <p style={{ color: '#f55', fontSize: 12, margin: 0 }}>{importError}</p>}
      <button
        onClick={handleImport}
        disabled={!edlInput.trim() || importing}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 12,
          alignSelf: 'flex-start', cursor: edlInput.trim() && !importing ? 'pointer' : 'default',
        }}
      >
        {importing ? 'Importing…' : 'Import EDL'}
      </button>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}

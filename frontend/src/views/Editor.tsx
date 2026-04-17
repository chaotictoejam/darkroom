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
import { api, subscribeToProgress } from '../api/client'
import type { EDLSegment, Project, WordCut, WordMute } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'

// ── Time-mapping utilities ─────────────────────────────────────────────────────
// The proxy video is the rendered output (all cuts applied). These functions
// convert between source-file time and output-timeline time so that seeking
// and transcript highlighting stay in sync regardless of which player is active.

type TimeRange = { start: number; end: number }

/** Build the list of kept source ranges, accounting for EDL + word cuts. */
function buildKeptRanges(
  edlSegments: EDLSegment[],
  wordCuts: WordCut[],
  totalDuration: number,
): TimeRange[] {
  let ranges: TimeRange[] =
    edlSegments.length > 0
      ? edlSegments.filter((s) => s.keep).map((s) => ({ start: s.start, end: s.end }))
      : [{ start: 0, end: totalDuration }]

  for (const cut of wordCuts) {
    ranges = ranges.flatMap((r) => {
      if (cut.end <= r.start || cut.start >= r.end) return [r]
      const pieces: TimeRange[] = []
      if (cut.start > r.start) pieces.push({ start: r.start, end: cut.start })
      if (cut.end < r.end) pieces.push({ start: cut.end, end: r.end })
      return pieces
    })
  }
  return ranges.filter((r) => r.end - r.start > 0.067) // drop sub-2-frame slivers
}

/** Source time → position in the output/proxy timeline. */
function sourceToOutputTime(sourceTime: number, keptRanges: TimeRange[]): number {
  let out = 0
  for (const r of keptRanges) {
    if (sourceTime <= r.start) break
    if (sourceTime >= r.end) {
      out += r.end - r.start
    } else {
      out += sourceTime - r.start
      break
    }
  }
  return out
}

/** Output/proxy timeline position → source file time. */
function outputToSourceTime(outputTime: number, keptRanges: TimeRange[]): number {
  let rem = outputTime
  for (const r of keptRanges) {
    const len = r.end - r.start
    if (rem <= len) return r.start + rem
    rem -= len
  }
  return keptRanges[keptRanges.length - 1]?.end ?? 0
}

interface Props {
  project: Project
  onChange: (project: Project) => void
  onBack: () => void
}

type SidePanel = 'shorts' | 'render' | 'manual' | 'advanced'
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

  // ── Proxy preview state ──────────────────────────────────────────────────────
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [proxyGenerating, setProxyGenerating] = useState(false)
  const proxyRef = useRef<HTMLVideoElement>(null)
  const previewUnsubRef = useRef<(() => void) | null>(null)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keptRangesRef = useRef<TimeRange[]>([])

  // Recompute kept ranges whenever the cut inputs change
  useEffect(() => {
    keptRangesRef.current = buildKeptRanges(
      project.edl?.segments ?? [],
      project.word_cuts ?? [],
      duration,
    )
  }, [project.edl, project.word_cuts, duration])

  useEffect(() => {
    api.status().then((s) => {
      setAnthropicConfigured(s.anthropic_configured)
      // Auto-open manual analysis panel when no API key
      if (!s.anthropic_configured && !project.edl) {
        setOpenPanels((prev) => new Set([...prev, 'manual']))
      }
    })
    // Cleanup on unmount
    return () => {
      previewUnsubRef.current?.()
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
    }
  }, [])

  async function handleAnalyze() {
    setAnalyzing(true)
    await api.analyze(project.id)
    onChange({ ...project, status: 'analyzing' })
  }

  /** Kick off a proxy render and update state when it completes. */
  function triggerPreview() {
    if (project.project_type === 'podcast') return
    previewUnsubRef.current?.()
    setProxyGenerating(true)

    const unsub = subscribeToProgress(project.id, (evt) => {
      if (evt.type === 'preview_ready' && evt.url) {
        // Cache-bust so the browser reloads the newly-rendered file
        setProxyUrl(evt.url + '?t=' + Date.now())
        setProxyGenerating(false)
        unsub()
      } else if (evt.type === 'preview_error') {
        setProxyGenerating(false)
        unsub()
      }
    })
    previewUnsubRef.current = unsub

    api.generatePreview(project.id).catch(() => {
      setProxyGenerating(false)
      unsub()
    })
  }

  /** Unified seek: uses proxy when available, falls back to raw VideoPreview. */
  function seekTo(sourceTime: number) {
    if (proxyRef.current) {
      proxyRef.current.currentTime = sourceToOutputTime(sourceTime, keptRangesRef.current)
    } else {
      videoRef.current?.seekTo(sourceTime)
    }
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
  const wordMutes: WordMute[] = project.word_mutes ?? []
  const hasEdl = !!project.edl

  const handleCutsChange = useCallback(
    (newCuts: WordCut[]) => {
      onChange({ ...project, word_cuts: newCuts })
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        api.saveWordCuts(project.id, newCuts)
      }, 600)
      // Debounce proxy re-render — wait for the user to stop cutting
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
      setProxyGenerating(true)
      previewDebounceRef.current = setTimeout(triggerPreview, 3000)
    },
    [project, onChange], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const handleMutesChange = useCallback(
    (newMutes: WordMute[]) => {
      onChange({ ...project, word_mutes: newMutes })
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        api.saveWordMutes(project.id, newMutes)
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

          {/* Spacer pushes advanced section to bottom */}
          <div style={{ flex: 1 }} />

          <SidebarSection
            label="Advanced Tools"
            open={openPanels.has('advanced')}
            onToggle={() => togglePanel('advanced')}
            danger
          >
            <AdvancedTools
              project={project}
              onChange={onChange}
              onOpenManualAnalysis={() => setOpenPanels((prev) => new Set([...prev, 'manual']))}
            />
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
                    wordMutes={wordMutes}
                    edlSegments={project.edl?.segments ?? []}
                    currentTime={currentTime}
                    onSeek={seekTo}
                    onCutsChange={handleCutsChange}
                    onMutesChange={handleMutesChange}
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
              {/* Layout selector — video only */}
              {project.project_type !== 'podcast' && (
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
              )}

              {/* Media player */}
              <div style={{ flex: 1, overflow: 'hidden', padding: 8, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                {videoSrc ? (
                  <>
                    {/* ── Proxy (WYSIWYG) player ────────────────────────────── */}
                    {proxyUrl && (
                      <div style={{ position: 'relative', width: '100%', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
                        {proxyGenerating && (
                          <div style={{
                            position: 'absolute', top: 6, right: 6, zIndex: 1,
                            background: 'rgba(0,0,0,0.75)', color: 'var(--accent)',
                            fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                            padding: '2px 7px', borderRadius: 3,
                          }}>
                            UPDATING…
                          </div>
                        )}
                        <video
                          ref={proxyRef}
                          src={proxyUrl}
                          controls
                          onTimeUpdate={() => {
                            const proxy = proxyRef.current
                            if (!proxy) return
                            const srcTime = outputToSourceTime(proxy.currentTime, keptRangesRef.current)
                            setCurrentTime(srcTime)
                            const shouldMute = wordMutes.some((m) => srcTime >= m.start && srcTime < m.end)
                            if (proxy.muted !== shouldMute) proxy.muted = shouldMute
                          }}
                          style={{ width: '100%', display: 'block', maxHeight: '40vh' }}
                        />
                      </div>
                    )}

                    {/* ── Raw source player — always mounted for metadata;
                            hidden once proxy is ready ─────────────────────── */}
                    <div style={{ display: proxyUrl ? 'none' : 'block', position: 'relative' }}>
                      {proxyGenerating && !proxyUrl && (
                        <div style={{
                          position: 'absolute', top: 6, right: 6, zIndex: 1,
                          background: 'rgba(0,0,0,0.75)', color: 'var(--accent)',
                          fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                          padding: '2px 7px', borderRadius: 3,
                        }}>
                          BUILDING PREVIEW…
                        </div>
                      )}
                      <VideoPreview
                        ref={videoRef}
                        src={videoSrc}
                        wordCuts={wordCuts}
                        wordMutes={wordMutes}
                        edlSegments={project.edl?.segments ?? []}
                        onTimeUpdate={setCurrentTime}
                        onDurationChange={(d) => {
                          setDuration(d)
                          // Auto-generate proxy once we know the source duration
                          if (d > 0 && project.project_type !== 'podcast') {
                            triggerPreview()
                          }
                        }}
                        isAudio={project.project_type === 'podcast'}
                      />
                    </div>
                  </>
                ) : (
                  <div style={{
                    width: '100%', background: 'var(--bg-card)', borderRadius: 8,
                    height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-muted)', fontSize: 13,
                  }}>
                    {project.project_type === 'podcast' ? 'No audio uploaded' : 'No video uploaded'}
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
            onSeek={seekTo}
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
  danger,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{
      borderTop: danger ? '1px solid rgba(180,50,50,0.3)' : 'none',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', background: 'none', border: 'none',
          color: open ? (danger ? '#c96' : 'var(--text)') : 'var(--text-muted)',
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

// ── Advanced tools ─────────────────────────────────────────────────────────────

function AdvancedTools({
  project,
  onChange,
  onOpenManualAnalysis,
}: {
  project: Project
  onChange: (p: Project) => void
  onOpenManualAnalysis: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)

  function exportTranscript() {
    const lines = project.merged_transcript.map(
      (seg) => `[${seg.speaker_name}]\n${seg.text}`,
    )
    download(`${project.name}-transcript.txt`, lines.join('\n\n'), 'text/plain')
  }

  function exportEdl() {
    if (!project.edl) return
    download(
      `${project.name}-edl.json`,
      JSON.stringify(project.edl, null, 2),
      'application/json',
    )
  }

  async function handleRedoConfirm() {
    setResetting(true)
    try {
      const updated = await api.resetEdl(project.id)
      onChange(updated)
      const { prompt } = await api.getPrompt(project.id)
      await navigator.clipboard.writeText(prompt)
      onOpenManualAnalysis()
    } finally {
      setResetting(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <AdvBtn label="Export Transcript" onClick={exportTranscript} />
        <AdvBtn label="Export EDL" onClick={exportEdl} disabled={!project.edl} />
        <div style={{ height: 1, background: 'rgba(180,50,50,0.2)', margin: '4px 0' }} />
        <AdvBtn label="Redo Manual Analysis" onClick={() => setConfirming(true)} warning />
      </div>

      {confirming && (
        <div
          onClick={() => setConfirming(false)}
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
              width: 360,
              display: 'flex', flexDirection: 'column', gap: 20,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Redo Manual Analysis?</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5 }}>
                This will clear the current EDL and copy the analysis prompt to your clipboard.
                Paste it into Claude to generate a new EDL.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirming(false)}
                disabled={resetting}
                style={{
                  background: 'none', border: '1px solid var(--border)',
                  color: 'var(--text)', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleRedoConfirm}
                disabled={resetting}
                style={{
                  background: 'var(--accent)', border: 'none',
                  color: '#fff', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, fontWeight: 600, cursor: resetting ? 'default' : 'pointer',
                }}
              >
                {resetting ? 'Resetting…' : 'Clear EDL & Copy Prompt'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function AdvBtn({
  label,
  onClick,
  disabled,
  warning,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  warning?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', textAlign: 'left',
        background: 'none',
        border: `1px solid ${warning ? 'rgba(180,50,50,0.35)' : 'var(--border)'}`,
        borderRadius: 6, padding: '6px 10px',
        color: disabled ? 'var(--text-muted)' : warning ? '#c96' : 'var(--text)',
        fontSize: 12, cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {label}
    </button>
  )
}

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
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
            Load a file to see the timeline
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

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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, subscribeToProgress } from '../api/client'
import type { EDL, EDLSegment, Project, Resolution, WordCut, WordMute } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'

// ── Shared cut utilities ───────────────────────────────────────────────────────

function mergeAndSortCuts(cuts: WordCut[]): WordCut[] {
  if (cuts.length === 0) return []
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const merged: WordCut[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i].start <= last.end + 0.05) {
      last.end = Math.max(last.end, sorted[i].end)
    } else {
      merged.push({ ...sorted[i] })
    }
  }
  return merged
}

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

type SidePanel = 'edl' | 'shorts' | 'render' | 'manual' | 'advanced'
type PreviewLayout = 'multi' | 'solo'

export default function Editor({ project, onChange, onBack }: Props) {
  const [analyzing, setAnalyzing] = useState(false)
  const [anthropicConfigured, setAnthropicConfigured] = useState<boolean | null>(null)
  const [openPanels, setOpenPanels] = useState<Set<SidePanel>>(
    () => new Set(project.edl ? (['edl'] as SidePanel[]) : []),
  )
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout>('multi')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [cleanView, setCleanView] = useState(false)
  const videoRef = useRef<VideoPreviewHandle>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Proxy preview state ──────────────────────────────────────────────────────
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [proxyGenerating, setProxyGenerating] = useState(false)
  const proxyRef = useRef<HTMLVideoElement>(null)
  const previewUnsubRef = useRef<(() => void) | null>(null)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keptRangesRef = useRef<TimeRange[]>([])
  const [outputDuration, setOutputDuration] = useState(0)

  // Recompute kept ranges and output duration whenever cuts/EDL/source duration change
  useEffect(() => {
    const ranges = buildKeptRanges(
      project.edl?.segments ?? [],
      project.word_cuts ?? [],
      duration,
    )
    keptRangesRef.current = ranges
    setOutputDuration(ranges.reduce((sum, r) => sum + r.end - r.start, 0))
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

  /** Toggle play/pause on whichever player is active. */
  function togglePlayPause() {
    if (proxyRef.current) {
      proxyRef.current.paused ? proxyRef.current.play() : proxyRef.current.pause()
    } else {
      videoRef.current?.togglePlayPause()
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
          {hasEdl && (
            <SidebarSection
              label={`Edit Decision List · ${project.edl!.segments.length} segments`}
              open={openPanels.has('edl')}
              onToggle={() => togglePanel('edl')}
            >
              <EdlPanel edl={project.edl!} onSeek={seekTo} />
            </SidebarSection>
          )}

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
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>
                  {project.merged_transcript.length} segments
                  {wordCuts.length > 0 && ` · ${wordCuts.length} cut${wordCuts.length !== 1 ? 's' : ''}`}
                </span>
                <button
                  onClick={() => setCleanView((v) => !v)}
                  title={cleanView ? 'Show all words including cuts' : 'Hide cut words (clean view)'}
                  style={{
                    background: cleanView ? 'var(--accent)' : 'var(--bg-card)',
                    color: cleanView ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${cleanView ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 5, padding: '2px 8px',
                    fontSize: 11, fontWeight: cleanView ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {cleanView ? 'Clean' : 'Raw'}
                </button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
                {project.merged_transcript.length > 0 ? (
                  <TranscriptEditor
                    segments={project.merged_transcript}
                    wordCuts={wordCuts}
                    wordMutes={wordMutes}
                    edlSegments={project.edl?.segments ?? []}
                    currentTime={currentTime}
                    cleanView={cleanView}
                    onSeek={seekTo}
                    onCutsChange={handleCutsChange}
                    onMutesChange={handleMutesChange}
                    onTogglePlay={togglePlayPause}
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
            outputDuration={outputDuration}
            outputCurrentTime={sourceToOutputTime(currentTime, keptRangesRef.current)}
            wordCuts={wordCuts}
            edlSegments={project.edl?.segments ?? []}
            segments={project.merged_transcript}
            projectId={project.id}
            speakerFile={primarySpeaker?.file}
            onSeek={seekTo}
            onCutsChange={handleCutsChange}
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

// ── EDL panel ─────────────────────────────────────────────────────────────────

function EdlPanel({ edl, onSeek }: { edl: EDL; onSeek: (t: number) => void }) {
  const kept = edl.segments.filter((s) => s.keep).length
  const cut = edl.segments.length - kept

  return (
    <div>
      <div style={{
        padding: '6px 12px 8px',
        fontSize: 11, color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 12,
      }}>
        <span style={{ color: '#4c8' }}>● {kept} kept</span>
        <span style={{ color: '#e55' }}>● {cut} cut</span>
      </div>

      {edl.segments.map((seg) => (
        <div
          key={seg.id}
          onClick={() => onSeek(seg.start)}
          style={{
            padding: '7px 12px 7px 10px',
            borderLeft: `3px solid ${seg.keep ? 'rgba(60,200,110,0.55)' : 'rgba(210,55,55,0.5)'}`,
            borderBottom: '1px solid var(--border)',
            cursor: 'pointer',
            display: 'flex', flexDirection: 'column', gap: 3,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-card)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {/* Time + badges row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
              {fmt(seg.start)} → {fmt(seg.end)}
            </span>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
              padding: '1px 5px', borderRadius: 3,
              background: seg.keep ? 'rgba(60,200,110,0.15)' : 'rgba(210,55,55,0.15)',
              color: seg.keep ? '#4c8' : '#e55',
            }}>
              {seg.keep ? 'KEEP' : 'CUT'}
            </span>
            {seg.camera && (
              <span style={{
                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--text-muted)',
                padding: '1px 5px', borderRadius: 3,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
              }}>
                CAM {seg.camera}
              </span>
            )}
          </div>

          {/* Reason */}
          {seg.reason && (
            <div style={{
              fontSize: 11, color: 'var(--text-muted)',
              lineHeight: 1.35, fontStyle: 'italic',
            }}>
              {seg.reason}
            </div>
          )}
        </div>
      ))}
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
  const [resolution, setResolution] = useState<Resolution>('1080p')

  async function handleRender() {
    const { warnings } = await api.resolutionCheck(project.id, resolution)
    if (warnings.length > 0) {
      const proceed = window.confirm(
        `${warnings.join('\n')}\n\nRender anyway?`,
      )
      if (!proceed) return
    }
    setRendering(true)
    try {
      await api.render(project.id, ['fullEdit'], { resolution })
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

      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['1080p', '4k'] as const).map((res) => (
          <button
            key={res}
            onClick={() => setResolution(res)}
            style={{
              flex: 1,
              background: resolution === res ? 'var(--accent)' : 'var(--bg-card)',
              color: resolution === res ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${resolution === res ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6, padding: '4px 8px', fontSize: 12,
              cursor: 'pointer', fontWeight: resolution === res ? 600 : 400,
            }}
          >
            {res === '4k' ? '4K' : '1080p'}
          </button>
        ))}
      </div>

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
          {render.warnings && render.warnings.length > 0 && (
            <div style={{ marginTop: 6, color: '#c96', fontSize: 11, lineHeight: 1.4 }}>
              {render.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Timeline / Tracker ─────────────────────────────────────────────────────────

const PAUSE_THRESHOLD = 0.4 // seconds
const DRAG_PX_THRESHOLD = 4  // pixels — less than this is a click, not a drag
const SCROLLBAR_H = 7        // px — height of the scrollbar strip

type DragMode = 'none' | 'selecting' | 'left-handle' | 'right-handle' | 'scrollbar'

function Timeline({
  duration,
  currentTime,
  outputDuration,
  outputCurrentTime,
  wordCuts,
  edlSegments,
  segments,
  projectId,
  speakerFile,
  onSeek,
  onCutsChange,
}: {
  duration: number
  currentTime: number
  outputDuration: number
  outputCurrentTime: number
  wordCuts: WordCut[]
  edlSegments: EDLSegment[]
  segments: import('../api/types').TranscriptSegment[]
  projectId: string
  speakerFile: string | undefined
  onSeek: (t: number) => void
  onCutsChange: (cuts: WordCut[]) => void
}) {
  const [waveform, setWaveform] = useState<number[]>([])
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragMode = useRef<DragMode>('none')
  const dragAnchorTime = useRef(0)
  const dragStartX = useRef(0)
  // Refs so the non-passive wheel handler always reads fresh values
  const zoomRef = useRef(1)
  const viewStartRef = useRef(0)
  const durationRef = useRef(duration)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])
  useEffect(() => { durationRef.current = duration }, [duration])

  // Fetch waveform once the file and duration are known
  useEffect(() => {
    if (!speakerFile || duration === 0) return
    api.getWaveform(projectId, speakerFile).then(({ waveform }) => setWaveform(waveform)).catch(() => {})
  }, [projectId, speakerFile, duration])

  // ── Zoom / pan ───────────────────────────────────────────────────────────────
  const visibleDuration = duration > 0 ? duration / zoom : 0

  // Clamp viewStart when zoom or source duration changes
  useEffect(() => {
    if (duration === 0) return
    setViewStart((vs) => Math.min(vs, Math.max(0, duration - duration / zoom)))
  }, [zoom, duration])

  // Auto-scroll to follow the playhead when zoomed in
  useEffect(() => {
    const z = zoomRef.current
    const dur = durationRef.current
    if (z <= 1 || dur === 0) return
    const visD = dur / z
    const vs = viewStartRef.current
    if (currentTime < vs || currentTime > vs + visD) {
      setViewStart(Math.max(0, Math.min(dur - visD, currentTime - visD * 0.1)))
    }
  }, [currentTime])

  // Non-passive wheel listener — zooms centered on mouse cursor
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const dur = durationRef.current
      if (dur === 0) return
      const z = zoomRef.current
      const vs = viewStartRef.current
      const rect = el.getBoundingClientRect()
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const visD = dur / z
      const mouseTime = vs + mouseRatio * visD
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25
      const newZoom = Math.max(1, Math.min(100, z * factor))
      if (newZoom === z) return
      const newVisD = dur / newZoom
      setZoom(newZoom)
      setViewStart(Math.max(0, Math.min(dur - newVisD, mouseTime - mouseRatio * newVisD)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  function applyZoom(newZoom: number) {
    if (duration === 0) return
    newZoom = Math.max(1, Math.min(100, newZoom))
    const newVisD = duration / newZoom
    setZoom(newZoom)
    if (newZoom <= 1) {
      setViewStart(0)
    } else {
      setViewStart(Math.max(0, Math.min(duration - newVisD, currentTime - newVisD / 2)))
    }
  }

  // Position helpers — all times are in source seconds, mapped to visible window
  const toLeft = (time: number) =>
    visibleDuration > 0 ? `${((time - viewStart) / visibleDuration) * 100}%` : '0%'
  const toWidth = (dt: number) =>
    visibleDuration > 0 ? `${(dt / visibleDuration) * 100}%` : '0%'
  const inView = (s: number, e: number) =>
    e > viewStart && s < viewStart + visibleDuration

  // Detect pauses
  const pauses = useMemo(() => {
    const result: Array<{ time: number; dur: number }> = []
    for (const seg of segments) {
      for (let i = 0; i < seg.words.length - 1; i++) {
        const gap = seg.words[i + 1].start - seg.words[i].end
        if (gap >= PAUSE_THRESHOLD) result.push({ time: seg.words[i].end + gap / 2, dur: gap })
      }
    }
    for (let i = 0; i < segments.length - 1; i++) {
      const gap = segments[i + 1].start - segments[i].end
      if (gap >= PAUSE_THRESHOLD) result.push({ time: segments[i].end + gap / 2, dur: gap })
    }
    return result
  }, [segments])

  // Delete/Escape keyboard handling when there's an active selection
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selection) return
      const tag = (e.target as HTMLElement).tagName
      if (['INPUT', 'TEXTAREA', 'VIDEO', 'AUDIO'].includes(tag)) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        commitCut()
      }
      if (e.key === 'Escape') setSelection(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selection, wordCuts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Maps screen x → source time, accounting for zoom/pan
  function pxToTime(clientX: number): number {
    if (!trackRef.current || duration === 0) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.max(0, Math.min(duration, viewStart + ratio * visibleDuration))
  }

  function commitCut() {
    if (!selection || selection.end - selection.start < 0.033) {
      setSelection(null)
      return
    }
    onCutsChange(mergeAndSortCuts([...wordCuts, { start: selection.start, end: selection.end }]))
    setSelection(null)
  }

  // ── Pointer handlers ──────────────────────────────────────────────────────
  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (duration === 0) return
    if ((e.target as HTMLElement).dataset.handle) return
    e.preventDefault()

    // Bottom strip = scrollbar zone (only when zoomed)
    if (zoom > 1 && trackRef.current) {
      const rect = trackRef.current.getBoundingClientRect()
      if (e.clientY > rect.bottom - SCROLLBAR_H - 2) {
        // Click on scrollbar — jump view to clicked position then start drag
        const ratio = (e.clientX - rect.left) / rect.width
        const clickTime = ratio * duration
        const maxVs = duration - visibleDuration
        const newVs = Math.max(0, Math.min(maxVs, clickTime - visibleDuration / 2))
        setViewStart(newVs)
        dragMode.current = 'scrollbar'
        dragStartX.current = e.clientX
        dragAnchorTime.current = newVs
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
    }

    dragStartX.current = e.clientX
    const t = pxToTime(e.clientX)
    dragAnchorTime.current = t
    dragMode.current = 'selecting'
    setSelection({ start: t, end: t })
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (dragMode.current === 'none' || duration === 0) return
    if (dragMode.current === 'scrollbar') {
      if (!trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const dx = e.clientX - dragStartX.current
      const dtPerPx = duration / rect.width
      const maxVs = duration - visibleDuration
      setViewStart(Math.max(0, Math.min(maxVs, dragAnchorTime.current + dx * dtPerPx)))
      return
    }
    const t = pxToTime(e.clientX)
    if (dragMode.current === 'selecting') {
      setSelection({ start: Math.min(dragAnchorTime.current, t), end: Math.max(dragAnchorTime.current, t) })
    } else if (dragMode.current === 'left-handle' && selection) {
      setSelection({ start: Math.min(t, selection.end - 0.033), end: selection.end })
    } else if (dragMode.current === 'right-handle' && selection) {
      setSelection({ start: selection.start, end: Math.max(t, selection.start + 0.033) })
    }
  }

  function onTrackPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (dragMode.current === 'none') return
    const wasDrag = Math.abs(e.clientX - dragStartX.current) >= DRAG_PX_THRESHOLD
    if (dragMode.current === 'selecting' && !wasDrag) {
      onSeek(pxToTime(e.clientX))
      setSelection(null)
    }
    dragMode.current = 'none'
  }

  // ── Handle pointer events (resize left/right edge of selection) ────────────
  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>, side: 'left' | 'right') {
    e.stopPropagation()
    e.preventDefault()
    if (!selection) return
    dragMode.current = side === 'left' ? 'left-handle' : 'right-handle'
    dragAnchorTime.current = side === 'left' ? selection.end : selection.start
    // Capture on the track so move/up fire there
    trackRef.current?.setPointerCapture(e.pointerId)
  }

  // Selection position in visible-window percentages (for overlay + toolbar)
  const selPct = selection && visibleDuration > 0
    ? {
        left: ((selection.start - viewStart) / visibleDuration) * 100,
        width: ((selection.end - selection.start) / visibleDuration) * 100,
      }
    : null

  // Scrollbar thumb geometry
  const scrollLeft = duration > 0 ? (viewStart / duration) * 100 : 0
  const scrollWidth = (1 / zoom) * 100

  return (
    <div style={{
      height: 100, flexShrink: 0,
      background: 'var(--bg-elevated)',
      borderTop: '1px solid var(--border)',
      padding: '8px 16px',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      {/* Labels row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {/* Zoom controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.04em', marginRight: 4 }}>
            TIMELINE
          </span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => applyZoom(zoom / 1.5)}
            disabled={zoom <= 1}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: zoom <= 1 ? 'var(--text-muted)' : 'var(--text)', borderRadius: 3, width: 18, height: 18, fontSize: 13, lineHeight: '16px', cursor: zoom <= 1 ? 'default' : 'pointer', padding: 0, opacity: zoom <= 1 ? 0.4 : 1 }}
          >−</button>
          <span
            style={{ fontSize: 11, color: zoom > 1 ? 'var(--accent)' : 'var(--text-muted)', fontFamily: 'monospace', minWidth: 32, textAlign: 'center', cursor: zoom > 1 ? 'pointer' : 'default' }}
            title={zoom > 1 ? 'Click to reset zoom' : undefined}
            onClick={zoom > 1 ? () => applyZoom(1) : undefined}
          >
            {zoom > 1 ? `${zoom.toFixed(zoom < 10 ? 1 : 0)}×` : '1×'}
          </span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => applyZoom(zoom * 1.5)}
            disabled={zoom >= 100}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: zoom >= 100 ? 'var(--text-muted)' : 'var(--text)', borderRadius: 3, width: 18, height: 18, fontSize: 13, lineHeight: '16px', cursor: zoom >= 100 ? 'default' : 'pointer', padding: 0, opacity: zoom >= 100 ? 0.4 : 1 }}
          >+</button>
        </div>

        {/* Time display */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {selection
            ? `${fmt(selection.start)} → ${fmt(selection.end)}  (${(selection.end - selection.start).toFixed(2)}s)`
            : outputDuration > 0
              ? `${fmt(outputCurrentTime)} / ${fmt(outputDuration)}${outputDuration < duration ? ` · ${fmt(duration - outputDuration)} cut` : ''}`
              : '--:-- / --:--'
          }
        </span>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        style={{
          flex: 1, position: 'relative',
          background: 'var(--bg-card)',
          borderRadius: 4, overflow: 'visible',
          cursor: duration > 0 ? 'crosshair' : 'default',
          border: '1px solid var(--border)',
          userSelect: 'none',
        }}
      >
        {/* Inner clip — leaves room for the scrollbar at the bottom when zoomed */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          bottom: zoom > 1 ? SCROLLBAR_H + 1 : 0,
          borderRadius: zoom > 1 ? '4px 4px 0 0' : 4,
          overflow: 'hidden',
        }}>
          {duration > 0 ? (
            <>
              {/* EDL segment shading */}
              {edlSegments.filter((s) => inView(s.start, s.end)).map((seg) => (
                <div
                  key={seg.id}
                  style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: toLeft(seg.start), width: toWidth(seg.end - seg.start),
                    background: seg.keep ? 'rgba(50,180,100,0.22)' : 'rgba(200,50,50,0.18)',
                  }}
                />
              ))}

              {/* Waveform — slice the visible portion of the waveform array */}
              {waveform.length > 0 && (() => {
                const startIdx = Math.floor((viewStart / duration) * waveform.length)
                const endIdx = Math.ceil(((viewStart + visibleDuration) / duration) * waveform.length)
                const slice = waveform.slice(startIdx, endIdx)
                return (
                  <svg
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                    viewBox={`0 0 ${slice.length} 100`}
                    preserveAspectRatio="none"
                  >
                    {slice.map((amp, i) => {
                      const h = Math.max(1, amp * 90)
                      return <rect key={i} x={i} y={(100 - h) / 2} width={0.7} height={h} fill="rgba(255,255,255,0.2)" />
                    })}
                  </svg>
                )
              })()}

              {/* Pause markers */}
              {pauses.filter((p) => inView(p.time - 0.5, p.time + 0.5)).map((p: { time: number; dur: number }, i: number) => (
                <div
                  key={i}
                  title={`${p.dur.toFixed(1)}s pause`}
                  style={{
                    position: 'absolute', top: 3,
                    left: toLeft(p.time),
                    transform: 'translateX(-50%)',
                    fontSize: p.dur >= 1 ? 11 : 9, lineHeight: 1,
                    color: p.dur >= 1 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.35)',
                    pointerEvents: 'none', userSelect: 'none', fontFamily: 'monospace',
                  }}
                >
                  {p.dur >= 1 ? '~~~' : '~'}
                </div>
              ))}

              {/* Committed word cuts */}
              {wordCuts.filter((c) => inView(c.start, c.end)).map((cut, i) => (
                <div
                  key={i}
                  style={{
                    position: 'absolute', top: '20%', bottom: '20%',
                    left: toLeft(cut.start),
                    width: toWidth(Math.max(0.033, cut.end - cut.start)),
                    background: 'rgba(229,51,51,0.75)', borderRadius: 1,
                  }}
                />
              ))}

              {/* Playhead */}
              {inView(currentTime - 0.1, currentTime + 0.1) && (
                <div
                  style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: toLeft(currentTime),
                    width: 2, background: 'var(--accent)',
                    transform: 'translateX(-50%)',
                    pointerEvents: 'none',
                    boxShadow: '0 0 4px var(--accent)',
                  }}
                />
              )}

              {/* Active selection overlay */}
              {selPct && selPct.width > 0 && (
                <>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${selPct.left}%`, width: `${selPct.width}%`, background: 'rgba(59,130,246,0.28)', pointerEvents: 'none' }} />
                  <div data-handle="left" onPointerDown={(e) => onHandlePointerDown(e, 'left')} style={{ position: 'absolute', top: 0, bottom: 0, width: 6, left: `${selPct.left}%`, transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.9)', cursor: 'ew-resize', zIndex: 2, borderRadius: '2px 0 0 2px' }} />
                  <div data-handle="right" onPointerDown={(e) => onHandlePointerDown(e, 'right')} style={{ position: 'absolute', top: 0, bottom: 0, width: 6, left: `${selPct.left + selPct.width}%`, transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.9)', cursor: 'ew-resize', zIndex: 2, borderRadius: '0 2px 2px 0' }} />
                </>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 12 }}>
              Load a file to see the timeline
            </div>
          )}
        </div>

        {/* Scrollbar — only visible when zoomed in */}
        {zoom > 1 && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            height: SCROLLBAR_H,
            background: 'rgba(0,0,0,0.35)',
            borderRadius: '0 0 4px 4px',
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', top: 1, bottom: 1,
              left: `${scrollLeft}%`,
              width: `${scrollWidth}%`,
              background: 'rgba(255,255,255,0.3)',
              borderRadius: 3,
              minWidth: 12,
            }} />
          </div>
        )}

        {/* Selection toolbar — floats above the track */}
        {selPct && selPct.width > 0.3 && selection && (
          <div
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              left: `${Math.max(5, Math.min(95, selPct.left + selPct.width / 2))}%`,
              transform: 'translateX(-50%)',
              zIndex: 100,
              display: 'flex', alignItems: 'center', gap: 1,
              background: '#1c1c1c', border: '1px solid #3a3a3a',
              borderRadius: 7, padding: '3px 4px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              fontSize: 12, whiteSpace: 'nowrap',
            }}
          >
            <button onPointerDown={(e) => e.stopPropagation()} onClick={commitCut} style={{ background: 'none', border: 'none', color: '#e05555', padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2e2e2e' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
              ✂ Cut {(selection.end - selection.start).toFixed(2)}s
            </button>
            <div style={{ width: 1, background: '#3a3a3a', alignSelf: 'stretch', margin: '3px 2px' }} />
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setSelection(null)} style={{ background: 'none', border: 'none', color: '#888', padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2e2e2e' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
              ✕
            </button>
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

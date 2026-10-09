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
import { api, ApiError, subscribeToProgress } from '../api/client'
import type { AiStatus, EDL, Project, WordCut, WordMute } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'
import Timeline from '../components/Timeline/Timeline'
import {
  buildKeptRanges,
  outputToSourceTime,
  sourceToOutputTime,
  type TimeRange,
} from '../components/Timeline/timeMap'
import { formatTimecode, formatTimestamp } from '../formatTime'

interface Props {
  project: Project
  onChange: (project: Project) => void
  onBack: () => void
}

type SidePanel = 'edl' | 'shorts' | 'render' | 'manual' | 'advanced'
type PreviewLayout = 'multi' | 'solo'

export default function Editor({ project, onChange, onBack }: Props) {
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeMessage, setAnalyzeMessage] = useState<string | null>(null)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const analyzeUnsubRef = useRef<(() => void) | null>(null)
  const [ai, setAi] = useState<AiStatus | null>(null)
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
      setAi(s.ai)
      // Auto-open manual analysis panel when no AI provider is set up
      if (!s.ai.configured && !project.edl) {
        setOpenPanels((prev) => new Set([...prev, 'manual']))
      }
    })
    // Cleanup on unmount
    return () => {
      previewUnsubRef.current?.()
      analyzeUnsubRef.current?.()
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
    }
  }, [])

  async function handleAnalyze() {
    setAnalyzing(true)
    setAnalyzeMessage(null)
    setAnalyzeError(null)

    function finish() {
      analyzeUnsubRef.current?.()
      analyzeUnsubRef.current = null
      setAnalyzing(false)
      setAnalyzeMessage(null)
      api.getProject(project.id).then((proj) => {
        onChange(proj)
        if (proj.status === 'error') {
          // The message is a traceback; its last line says what went wrong
          setAnalyzeError(proj.progress.message.trim().split('\n').pop() ?? 'Analysis failed')
        } else if (proj.edl) {
          setOpenPanels((prev) => new Set([...prev, 'edl']))
        }
      })
    }

    // Subscribe before starting the job so the result can't be missed
    analyzeUnsubRef.current?.()
    analyzeUnsubRef.current = subscribeToProgress(
      project.id,
      (evt) => {
        if (evt.type) return
        if (evt.progress?.message) setAnalyzeMessage(evt.progress.message)
        if (evt.status === 'ready' || evt.status === 'error') finish()
      },
      finish,
    )
    try {
      await api.analyze(project.id)
    } catch (err) {
      analyzeUnsubRef.current?.()
      analyzeUnsubRef.current = null
      setAnalyzing(false)
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed to start')
      return
    }
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

  const edlSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Restore (keep) or cut EDL segments by id. */
  function setSegmentsKept(ids: Set<string>, keep: boolean) {
    if (!project.edl) return
    const edl = {
      ...project.edl,
      segments: project.edl.segments.map((s) => (ids.has(s.id) ? { ...s, keep } : s)),
    }
    onChange({ ...project, edl })
    if (edlSaveTimer.current) clearTimeout(edlSaveTimer.current)
    edlSaveTimer.current = setTimeout(() => {
      api.updateEdl(project.id, edl)
    }, 600)
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
    if (project.project_type !== 'podcast') {
      setProxyGenerating(true)
      previewDebounceRef.current = setTimeout(triggerPreview, 3000)
    }
  }

  /** Fix mis-transcribed words; throws so the editor can keep the edit box open on failure. */
  async function handleEditWords(segIndex: number, first: number, last: number, text: string) {
    const { segment } = await api.updateTranscriptWords(project.id, segIndex, first, last, text)
    onChange({
      ...project,
      merged_transcript: project.merged_transcript.map((s, i) => (i === segIndex ? segment : s)),
    })
  }

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
          {analyzeError && (
            <span style={{ color: '#f55', fontSize: 12, maxWidth: 480 }} title={analyzeError}>
              {analyzeError}
            </span>
          )}
          {!hasEdl && ai?.configured && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {analyzing && analyzeMessage ? analyzeMessage : `Sends the transcript to ${ai.destination}`}
            </span>
          )}
          {!hasEdl && ai?.configured && (
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
          {!hasEdl && ai?.configured === false && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {ai.provider === 'bedrock' ? 'No AWS credentials found' : 'No API key'} — use Manual Analysis in the sidebar
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
              <EdlPanel edl={project.edl!} onSeek={seekTo} onSetKept={setSegmentsKept} />
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
                highlight={ai?.configured === false}
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
                    onSetEdlKept={setSegmentsKept}
                    onEditWords={handleEditWords}
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

function EdlPanel({ edl, onSeek, onSetKept }: {
  edl: EDL
  onSeek: (t: number) => void
  onSetKept: (ids: Set<string>, keep: boolean) => void
}) {
  const kept = edl.segments.filter((s) => s.keep).length
  const cut = edl.segments.length - kept
  const cutIds = new Set(edl.segments.filter((s) => !s.keep).map((s) => s.id))

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
        {cut > 0 && (
          <button
            onClick={() => onSetKept(cutIds, true)}
            title="Keep every segment the EDL cut"
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', padding: 0,
              color: 'var(--accent)', fontSize: 11, cursor: 'pointer',
            }}
          >
            Restore all
          </button>
        )}
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
              {formatTimecode(seg.start)} → {formatTimecode(seg.end)}
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
            <button
              onClick={(e) => {
                e.stopPropagation()
                onSetKept(new Set([seg.id]), !seg.keep)
              }}
              title={seg.keep ? 'Cut this segment' : 'Keep this segment'}
              style={{
                marginLeft: 'auto', flexShrink: 0,
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 3,
                color: 'var(--text-muted)', fontSize: 10, padding: '1px 6px', cursor: 'pointer',
              }}
            >
              {seg.keep ? 'Cut' : 'Restore'}
            </button>
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
      (seg) => `[${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}] ${seg.speaker_name}\n${seg.text}`,
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

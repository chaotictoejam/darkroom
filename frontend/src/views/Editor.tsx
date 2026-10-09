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
import type { AiStatus, Project, WordCut, WordMute } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'
import SidebarSection from '../components/Editor/SidebarSection'
import EdlPanel from '../components/Editor/EdlPanel'
import AdvancedTools from '../components/Editor/AdvancedTools'
import RenderPanel from '../components/Editor/RenderPanel'
import ManualAnalysis from '../components/Editor/ManualAnalysis'
import Timeline from '../components/Timeline/Timeline'
import {
  buildKeptRanges,
  outputToSourceTime,
  sourceToOutputTime,
  type TimeRange,
} from '../components/Timeline/timeMap'

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
            <RenderPanel project={project} onChange={onChange} />
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

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
 * The sidebar, preview and timeline can be resized by dragging their edges (ResizeHandle).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, subscribeToProgress } from '../api/client'
import type { AiStatus, LibraryTrack, Project, SoundCue, SoundTrack, WordCut, WordMute } from '../api/types'
import VideoPreview, { type VideoPreviewHandle } from '../components/VideoPreview/VideoPreview'
import TranscriptEditor from '../components/TranscriptEditor/TranscriptEditor'
import SidebarSection from '../components/Editor/SidebarSection'
import EdlPanel from '../components/Editor/EdlPanel'
import AdvancedTools from '../components/Editor/AdvancedTools'
import RenderPanel from '../components/Editor/RenderPanel'
import PublishPanel from '../components/Editor/PublishPanel'
import SpeakersPanel from '../components/Editor/SpeakersPanel'
import ProjectName from '../components/Editor/ProjectName'
import ManualAnalysis from '../components/Editor/ManualAnalysis'
import MusicPanel from '../components/Editor/MusicPanel'
import AnalyzeConfirm from '../components/Editor/AnalyzeConfirm'
import Timeline from '../components/Timeline/Timeline'
import ResizeHandle, { useStoredSize } from '../components/ResizeHandle'
import {
  buildKeptRanges,
  outputToSourceTime,
  sourceToOutputTime,
  type TimeRange,
} from '../components/Timeline/timeMap'
import { cueBlocks, replaceCue } from '../components/Timeline/musicCues'

interface Props {
  project: Project
  onChange: (project: Project) => void
  onBack: () => void
}

/** Cut and split changes kept for undo. */
const CUT_HISTORY_LIMIT = 100

// Resizable panels (px)
const SIDEBAR_W = 260
const SIDEBAR_MIN = 200
const TIMELINE_H = 196
const TIMELINE_MIN = 120
const PREVIEW_W = 380
const PREVIEW_MIN = 240
const TRANSCRIPT_MIN = 300

type SidePanel = 'edl' | 'shorts' | 'speakers' | 'music' | 'render' | 'publish' | 'manual' | 'advanced'
type PreviewLayout = 'multi' | 'solo'

export default function Editor({ project, onChange, onBack }: Props) {
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeMessage, setAnalyzeMessage] = useState<string | null>(null)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const analyzeUnsubRef = useRef<(() => void) | null>(null)
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [confirmingAnalyze, setConfirmingAnalyze] = useState(false)
  const [openPanels, setOpenPanels] = useState<Set<SidePanel>>(
    () => new Set(project.edl ? (['edl'] as SidePanel[]) : []),
  )
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout>('multi')
  const [retranscribing, setRetranscribing] = useState(false)
  const [retranscribeNote, setRetranscribeNote] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [library, setLibrary] = useState<LibraryTrack[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  const soundCues: SoundCue[] = project.sound_cues ?? []
  const soundTracks: SoundTrack[] = project.sound_tracks ?? []
  /**
   * Whether playback goes through a rendered proxy. Video projects always do.
   * An audio-only project plays its source files directly and applies cuts as it
   * goes — until it has music, which only exists in the mix, so from then on the
   * proxy is the only way to hear the balance.
   */
  const audioProxy = project.project_type === 'podcast'
  const usesProxy = !audioProxy || soundCues.length > 0
  const [cleanView, setCleanView] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useStoredSize('darkroom.sidebarWidth', SIDEBAR_W)
  const [timelineHeight, setTimelineHeight] = useStoredSize('darkroom.timelineHeight', TIMELINE_H)
  const [previewWidth, setPreviewWidth] = useStoredSize('darkroom.previewWidth', PREVIEW_W)
  const videoRef = useRef<VideoPreviewHandle>(null)
  // For async callbacks that finish after the project may have changed
  const latestProject = useRef(project)
  latestProject.current = project
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Proxy preview state ──────────────────────────────────────────────────────
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [proxyGenerating, setProxyGenerating] = useState(false)
  const proxyRef = useRef<HTMLMediaElement | null>(null)
  const previewUnsubRef = useRef<(() => void) | null>(null)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cuesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keptRangesRef = useRef<TimeRange[]>([])
  const [outputDuration, setOutputDuration] = useState(0)
  /** Kept ranges the loaded proxy was rendered from — behind keptRangesRef while a render runs. */
  const proxyRangesRef = useRef<TimeRange[]>([])
  /** The proxy URL the player is on, readable from the WebSocket handler. */
  const proxyUrlRef = useRef<string | null>(null)
  /** Where playback picks up once a freshly rendered proxy has loaded. */
  const resumeRef = useRef<{ sourceTime: number; playing: boolean } | null>(null)
  /** Proxy URL we already rebuilt after a load error, so one failure can't loop. */
  const recoveredUrlRef = useRef<string | null>(null)

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

  // The music library is global; the editor holds it so the timeline can label
  // cues and the Music panel can add to it.
  useEffect(() => {
    api.listMusic()
      .then(({ tracks }) => setLibrary(tracks))
      .catch(() => {})
      .finally(() => setLibraryLoading(false))
  }, [])

  useEffect(() => {
    api.status().then((s) => {
      setAi(s.ai)
      // Auto-open manual analysis panel when no AI provider is set up (or it is refused)
      if ((!s.ai.configured || s.ai.blocked) && !project.edl) {
        setOpenPanels((prev) => new Set([...prev, 'manual']))
      }
    })
    // Cleanup on unmount
    return () => {
      previewUnsubRef.current?.()
      analyzeUnsubRef.current?.()
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
      // The pending cue save is deliberately left to fire: cancelling it on the
      // way out of the editor would drop the last change, like the word-cut save.
    }
  }, [])

  async function handleAnalyze() {
    setConfirmingAnalyze(false)
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

  // One preview subscription for as long as the editor is open. Re-subscribing
  // per render lost the preview_ready of the render already in flight, leaving
  // the editor on a proxy that no longer matches the cuts.
  useEffect(() => {
    if (!usesProxy) return
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | null = null

    function connect() {
      previewUnsubRef.current = subscribeToProgress(
        project.id,
        (evt) => {
          if (evt.type === 'preview_generating') {
            setProxyGenerating(true)
          } else if (evt.type === 'preview_error') {
            setProxyGenerating(false)
          } else if (evt.type === 'preview_ready' && evt.url) {
            setProxyGenerating(false)
            // Same file: nothing to swap, and no load event to resume on
            if (evt.url === proxyUrlRef.current) return
            // Carry the playhead and play state over to the new render
            const proxy = proxyRef.current
            resumeRef.current = proxy && proxy.currentTime > 0
              ? {
                  sourceTime: outputToSourceTime(proxy.currentTime, proxyRangesRef.current),
                  playing: !proxy.paused,
                }
              : null
            proxyRangesRef.current = keptRangesRef.current
            recoveredUrlRef.current = null
            proxyUrlRef.current = evt.url
            setProxyUrl(evt.url)
          }
        },
        // The backend closes the socket when any job finishes; keep listening.
        () => {
          if (!stopped) retry = setTimeout(connect, 1000)
        },
      )
    }
    connect()

    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      previewUnsubRef.current?.()
      previewUnsubRef.current = null
    }
  }, [project.id, usesProxy])

  // Without a proxy (audio-only and no music) the source player drives playback
  useEffect(() => {
    if (!usesProxy) {
      proxyUrlRef.current = null
      setProxyUrl(null)
      setProxyGenerating(false)
    }
  }, [usesProxy])

  /** Ask the backend for a proxy render of the current edit. */
  function requestPreview() {
    setProxyGenerating(true)
    api.generatePreview(project.id).catch(() => setProxyGenerating(false))
  }

  function triggerPreview() {
    if (!usesProxy) return
    requestPreview()
  }

  const setProxyEl = useCallback((el: HTMLMediaElement | null) => {
    proxyRef.current = el
  }, [])

  /** Follow the proxy's playhead in source time, and honour word mutes. */
  function onProxyTime() {
    const proxy = proxyRef.current
    if (!proxy || resumeRef.current) return
    const srcTime = outputToSourceTime(proxy.currentTime, proxyRangesRef.current)
    setCurrentTime(srcTime)
    const shouldMute = wordMutes.some((m) => srcTime >= m.start && srcTime < m.end)
    if (proxy.muted !== shouldMute) proxy.muted = shouldMute
  }

  /** Pick playback back up where the previous proxy left off. */
  function onProxyLoaded() {
    const proxy = proxyRef.current
    const resume = resumeRef.current
    resumeRef.current = null
    if (!proxy || !resume) return
    proxy.currentTime = sourceToOutputTime(resume.sourceTime, proxyRangesRef.current)
    if (resume.playing) void proxy.play()
  }

  /** The file went away or never finished — fall back to the source player and
   *  ask for a fresh render, once. */
  function onProxyError() {
    if (recoveredUrlRef.current === proxyUrl) return
    recoveredUrlRef.current = proxyUrl
    resumeRef.current = null
    proxyUrlRef.current = null
    setProxyUrl(null)
    triggerPreview()
  }

  /** Unified seek: uses proxy when available, falls back to raw VideoPreview. */
  function seekTo(sourceTime: number) {
    if (proxyRef.current) {
      // The proxy may be a render behind, so map through the ranges it was built from
      proxyRef.current.currentTime = sourceToOutputTime(sourceTime, proxyRangesRef.current)
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

  const timelineSplits: number[] = project.timeline_splits ?? []
  const splitsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Undo/redo history of cuts and timeline splits, shared by the transcript and timeline
  type CutsSnapshot = { cuts: WordCut[]; splits: number[] }
  const cutsHistory = useRef<{ undo: CutsSnapshot[]; redo: CutsSnapshot[] }>({ undo: [], redo: [] })
  const [, setHistoryVersion] = useState(0)

  /** Apply and save cuts and splits without touching the history; only what changed is saved. */
  const applyCuts = useCallback(
    ({ cuts, splits }: CutsSnapshot) => {
      onChange({ ...project, word_cuts: cuts, timeline_splits: splits })
      if (splits !== timelineSplits) {
        if (splitsSaveTimer.current) clearTimeout(splitsSaveTimer.current)
        splitsSaveTimer.current = setTimeout(() => {
          api.patchProject(project.id, { timeline_splits: splits })
        }, 600)
      }
      if (cuts === wordCuts) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        api.saveWordCuts(project.id, cuts)
      }, 600)
      // Debounce proxy re-render — wait for the user to stop cutting
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
      if (usesProxy) {
        setProxyGenerating(true)
        previewDebounceRef.current = setTimeout(triggerPreview, 3000)
      }
    },
    [project, onChange, wordCuts, timelineSplits], // eslint-disable-line react-hooks/exhaustive-deps
  )

  /**
   * Save the project's cues (and sound tracks) and rebuild the preview mix.
   *
   * Both are debounced: dragging a level slider fires a change per pixel, and
   * each one would otherwise be a PUT and a proxy render.
   */
  const handleCuesChange = useCallback(
    (cues: SoundCue[], tracks?: SoundTrack[]) => {
      onChange({ ...project, sound_cues: cues, ...(tracks ? { sound_tracks: tracks } : {}) })
      if (cuesSaveTimer.current) clearTimeout(cuesSaveTimer.current)
      cuesSaveTimer.current = setTimeout(() => {
        api.saveSoundCues(project.id, cues, tracks).catch(() => {})
      }, 500)
      // The first cue on an audio-only project is what gives it a proxy at all,
      // so decide from the cues being saved, not from the render we were called in.
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
      if (!audioProxy || cues.length > 0) {
        setProxyGenerating(true)
        previewDebounceRef.current = setTimeout(requestPreview, 2000)
      }
    },
    [project, onChange, audioProxy], // eslint-disable-line react-hooks/exhaustive-deps
  )

  /** Record the current cuts and splits for undo, then apply the new ones. */
  const commitEdit = useCallback(
    (next: CutsSnapshot) => {
      const history = cutsHistory.current
      history.undo = [...history.undo, { cuts: wordCuts, splits: timelineSplits }].slice(-CUT_HISTORY_LIMIT)
      history.redo = []
      setHistoryVersion((v) => v + 1)
      applyCuts(next)
    },
    [applyCuts, wordCuts, timelineSplits],
  )

  const handleCutsChange = useCallback(
    (newCuts: WordCut[]) => commitEdit({ cuts: newCuts, splits: timelineSplits }),
    [commitEdit, timelineSplits],
  )

  const handleSplitsChange = useCallback(
    (newSplits: number[]) => commitEdit({ cuts: wordCuts, splits: newSplits }),
    [commitEdit, wordCuts],
  )

  /**
   * Re-run Whisper over a stretch of the recording and splice the result into
   * the transcript. For speech the full pass dropped or misheard: the window is
   * decoded on its own, so it chunks differently and is re-aligned within it.
   *
   * Only the transcript is replaced — cuts, mutes and splits are the user's, so
   * recovered speech inside a cut stays cut until they restore it, which the
   * note says.
   */
  const handleRetranscribe = useCallback(
    async (start: number, end: number) => {
      setRetranscribing(true)
      setRetranscribeNote(null)
      try {
        const res = await api.retranscribe(latestProject.current.id, start, end)
        // Merge in only the transcript: local cuts may not have been saved yet
        onChange({
          ...latestProject.current,
          merged_transcript: res.project.merged_transcript,
          transcripts: res.project.transcripts,
        })
        const cut = (latestProject.current.word_cuts ?? []).some((c) => c.start < end && c.end > start)
        setRetranscribeNote(
          res.words_after === 0
            ? 'Re-transcribed: no speech found in that stretch'
            : res.words_before === 0
              ? `Recovered ${res.words_after} words that were missing${cut ? ' — Restore the selection to hear them' : ''}`
              : `Re-transcribed ${res.words_after} words (was ${res.words_before})`,
        )
      } catch (err) {
        setRetranscribeNote(err instanceof Error ? err.message : 'Re-transcription failed')
      } finally {
        setRetranscribing(false)
      }
    },
    [onChange],
  )

  /** Step cuts and splits back (or forward) through the history. */
  const stepCutsHistory = useCallback(
    (direction: 'undo' | 'redo') => {
      const history = cutsHistory.current
      const from = direction === 'undo' ? history.undo : history.redo
      const target = from[from.length - 1]
      if (!target) return
      from.pop()
      ;(direction === 'undo' ? history.redo : history.undo).push({ cuts: wordCuts, splits: timelineSplits })
      setHistoryVersion((v) => v + 1)
      applyCuts(target)
    },
    [applyCuts, wordCuts, timelineSplits],
  )

  // Ctrl/Cmd+Z undoes a cut or split change; Ctrl/Cmd+Shift+Z or Ctrl+Y redoes it
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        stepCutsHistory('undo')
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        stepCutsHistory('redo')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [stepCutsHistory])

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
    if (usesProxy) {
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

  // Leave room for the transcript and preview, however large the panels were saved
  const sidebarMax = Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.4))
  const timelineMax = Math.max(TIMELINE_MIN, Math.round(window.innerHeight * 0.6))
  const previewMax = Math.max(PREVIEW_MIN, Math.round(Math.min(
    window.innerWidth * 0.6,
    window.innerWidth - Math.min(sidebarWidth, sidebarMax) - TRANSCRIPT_MIN,
  )))

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
        <ProjectName project={project} onRenamed={(name) => onChange({ ...latestProject.current, name })} />
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {project.status}</span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {analyzeError && (
            <span style={{ color: '#f55', fontSize: 12, maxWidth: 480 }} title={analyzeError}>
              {analyzeError}
            </span>
          )}
          {retranscribeNote && (
            <span
              onClick={() => setRetranscribeNote(null)}
              title="Dismiss"
              style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 480, cursor: 'pointer' }}
            >
              {retranscribeNote}
            </span>
          )}
          {!hasEdl && ai?.configured && !ai.blocked && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {analyzing && analyzeMessage ? analyzeMessage : `Sends the transcript to ${ai.destination}`}
            </span>
          )}
          {!hasEdl && ai?.configured && !ai.blocked && (
            <button
              onClick={() => setConfirmingAnalyze(true)}
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
          {!hasEdl && ai?.configured && ai.blocked && (
            <span title={ai.blocked} style={{ color: '#e8a33d', fontSize: 12, maxWidth: 420 }}>
              Analyse refused: {ai.blocked}
            </span>
          )}
          {!hasEdl && ai?.configured === false && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {ai.provider === 'bedrock' ? 'No AWS credentials found' : 'No API key'} — use Manual Analysis in the sidebar
            </span>
          )}
        </div>
      </header>

      {confirmingAnalyze && ai && (
        <AnalyzeConfirm ai={ai} onCancel={() => setConfirmingAnalyze(false)} onConfirm={handleAnalyze} />
      )}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* ── Left Sidebar ─────────────────────────────────────────────────── */}
        <aside style={{
          width: Math.min(sidebarWidth, sidebarMax), flexShrink: 0,
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
            label="Speakers"
            open={openPanels.has('speakers')}
            onToggle={() => togglePanel('speakers')}
          >
            <SpeakersPanel project={project} onChange={onChange} />
          </SidebarSection>

          <SidebarSection
            label={`Music & sound${soundCues.length > 0 ? ` · ${soundCues.length}` : ''}`}
            open={openPanels.has('music')}
            onToggle={() => togglePanel('music')}
          >
            <MusicPanel
              project={project}
              currentTime={currentTime}
              duration={duration}
              keptRanges={keptRangesRef.current}
              library={library}
              loading={libraryLoading}
              onLibraryChange={setLibrary}
              selectedCueId={selectedCueId}
              onSelectCue={setSelectedCueId}
              onCuesChange={handleCuesChange}
            />
          </SidebarSection>

          <SidebarSection
            label="Render"
            open={openPanels.has('render')}
            onToggle={() => togglePanel('render')}
          >
            <RenderPanel project={project} onChange={onChange} />
          </SidebarSection>

          <SidebarSection
            label="Publish to DarkRelay"
            open={openPanels.has('publish')}
            onToggle={() => togglePanel('publish')}
          >
            <PublishPanel
              project={project}
              keptRanges={keptRangesRef.current}
              currentTime={currentTime}
              onChange={onChange}
            />
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
              duration={duration}
              onChange={onChange}
              onOpenManualAnalysis={() => setOpenPanels((prev) => new Set([...prev, 'manual']))}
            />
          </SidebarSection>
        </aside>
        <ResizeHandle
          axis="x"
          size={Math.min(sidebarWidth, sidebarMax)}
          min={SIDEBAR_MIN}
          max={sidebarMax}
          defaultSize={SIDEBAR_W}
          onResize={setSidebarWidth}
          label="Resize sidebar"
        />

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
                    onUndoCuts={cutsHistory.current.undo.length > 0 ? () => stepCutsHistory('undo') : undefined}
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
            <ResizeHandle
              axis="x"
              invert
              size={Math.min(previewWidth, previewMax)}
              min={PREVIEW_MIN}
              max={previewMax}
              defaultSize={PREVIEW_W}
              onResize={setPreviewWidth}
              label="Resize preview"
            />
            <div style={{
              width: Math.min(previewWidth, previewMax), flexShrink: 0,
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
                        {/* An audio-only mix plays through <audio> — same
                            handlers, since both are media elements. */}
                        {audioProxy ? (
                          <audio
                            ref={setProxyEl}
                            src={proxyUrl}
                            controls
                            onTimeUpdate={onProxyTime}
                            onLoadedMetadata={onProxyLoaded}
                            onError={onProxyError}
                            style={{ width: '100%', display: 'block' }}
                          />
                        ) : (
                          <video
                            ref={setProxyEl}
                            src={proxyUrl}
                            controls
                            onTimeUpdate={onProxyTime}
                            onLoadedMetadata={onProxyLoaded}
                            onError={onProxyError}
                            style={{ width: '100%', display: 'block', maxHeight: '40vh' }}
                          />
                        )}
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
                          if (d > 0 && usesProxy) {
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
          <ResizeHandle
            axis="y"
            invert
            size={Math.min(timelineHeight, timelineMax)}
            min={TIMELINE_MIN}
            max={timelineMax}
            defaultSize={TIMELINE_H}
            onResize={setTimelineHeight}
            label="Resize timeline"
          />
          <Timeline
            height={Math.min(timelineHeight, timelineMax)}
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
            splits={timelineSplits}
            onSplitsChange={handleSplitsChange}
            retranscribing={retranscribing}
            onRetranscribe={handleRetranscribe}
            cueBlocks={cueBlocks(soundCues, library, keptRangesRef.current, duration)}
            soundTrack={soundTracks[0]}
            selectedCueId={selectedCueId}
            onSelectCue={(id) => {
              setSelectedCueId(id)
              if (id) setOpenPanels((prev) => new Set([...prev, 'music']))
            }}
            onCueChange={(cue) => handleCuesChange(replaceCue(soundCues, cue))}
          />
        </div>
      </div>
    </div>
  )
}

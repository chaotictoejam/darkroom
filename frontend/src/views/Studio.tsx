/**
 * Studio view — record a podcast in takes.
 *
 *   Choose sources → Studio: [● Record] → [■ Stop] → take is finalised and
 *   transcribed in the background → record more → [Finish & edit →]
 *
 * Each mic's MediaRecorder chunks are streamed to the backend as they arrive,
 * so a crash loses seconds rather than the session. Plan: docs/recording-studio.md
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, subscribeToProgress } from '../api/client'
import type { Project, Take } from '../api/types'
import { desktop } from '../desktop'
import { ChunkUploader } from '../components/Studio/chunkUploader'
import { formatElapsed } from '../components/Studio/format'
import { MicEngine } from '../components/Studio/micEngine'
import SourcePicker, { type MicChoice } from '../components/Studio/SourcePicker'
import TakesStrip from '../components/Studio/TakesStrip'
import WaveformLanes, { type RecordedSpan } from '../components/Studio/WaveformLanes'

// Voice-grade Opus; converted to WAV on Stop.
const AUDIO_BITS_PER_SECOND = 128_000
const CHUNK_MS = 1000

interface Props {
  project: Project
  onBack: () => void
  onFinished: (project: Project) => void
}

type RecState = 'idle' | 'starting' | 'recording' | 'stopping'

interface ActiveTake {
  takeId: string
  recorders: MediaRecorder[]
  uploaders: ChunkUploader[]
  startedAt: number
}

function pickMimeType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

function initialSources(project: Project): MicChoice[] {
  const ps = project.participants ?? []
  return ps.length > 0
    ? ps.map((p) => ({ id: p.id, name: p.name, deviceId: '' }))
    : [{ id: 'A', name: '', deviceId: '' }]
}

export default function Studio({ project, onBack, onFinished }: Props) {
  const [stage, setStage] = useState<'sources' | 'studio'>('sources')
  const [permission, setPermission] = useState<'idle' | 'requesting' | 'granted'>('idle')
  const [engine, setEngine] = useState<MicEngine | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [sources, setSources] = useState<MicChoice[]>(() => initialSources(project))
  const [openKeys, setOpenKeys] = useState<string[]>([])
  const [language, setLanguage] = useState(project.transcribe_language ?? 'en')
  const [model, setModel] = useState(project.transcribe_model ?? 'medium')
  const [takes, setTakes] = useState<Take[]>(project.takes ?? [])
  const [recState, setRecState] = useState<RecState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [uploadIssue, setUploadIssue] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const spans = useRef<RecordedSpan[]>([])
  const active = useRef<ActiveTake | null>(null)
  const assembling = useRef(false)

  const upsertTake = useCallback((take: Take) => {
    setTakes((prev) => prev.some((t) => t.id === take.id)
      ? prev.map((t) => (t.id === take.id ? take : t))
      : [...prev, take])
  }, [])

  const reloadTakes = useCallback(async () => {
    const proj = await api.getProject(project.id)
    setTakes(proj.takes ?? [])
    return proj.takes ?? []
  }, [project.id])

  // ── Take progress over WebSocket, reconnecting if the backend restarts ────
  useEffect(() => {
    let unsub = () => {}
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const connect = () => {
      unsub = subscribeToProgress(
        project.id,
        (evt) => { if (evt.type === 'take' && evt.take) upsertTake(evt.take) },
        () => {
          if (stopped) return
          retry = setTimeout(() => { connect(); void reloadTakes().catch(() => {}) }, 2000)
        },
      )
    }
    connect()
    return () => { stopped = true; clearTimeout(retry); unsub() }
  }, [project.id, upsertTake, reloadTakes])

  // A take left "recording" by a closed or reloaded window: finalise what reached disk.
  useEffect(() => {
    for (const t of project.takes ?? []) {
      if (t.status === 'recording') void api.stopTake(project.id, t.id).then(upsertTake).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Microphones ────────────────────────────────────────────────────────────

  const refreshDevices = useCallback(async () => {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    // Chromium lists "default" and "communications" as aliases of a real device;
    // hide them so two sources can't silently record the same mic.
    const real = all.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    const list = real.length > 0 ? real : all
    setDevices(list)
    setSources((prev) => prev.map((s, i) => (list.some((d) => d.deviceId === s.deviceId)
      ? s
      : { ...s, deviceId: (list[i] ?? list[0])?.deviceId ?? '' })))
  }, [])

  async function enableMics() {
    setError(null)
    setPermission('requesting')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Recording needs a secure context. Open Darkroom via localhost or the desktop app.')
      }
      if (desktop && !(await desktop.requestMicrophoneAccess())) {
        throw new Error('Microphone access was denied. Allow Darkroom in your system privacy settings, then try again.')
      }
      // Device labels and IDs are only exposed after a permission grant.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
      await refreshDevices()
      setEngine(new MicEngine())
      setPermission('granted')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPermission('idle')
    }
  }

  useEffect(() => () => engine?.close(), [engine])

  // Keep the device list current, except mid-take: changing a device would
  // reopen the stream under its recorder.
  useEffect(() => {
    if (permission !== 'granted' || recState !== 'idle') return
    const md = navigator.mediaDevices
    const handler = () => { void refreshDevices() }
    md.addEventListener('devicechange', handler)
    return () => md.removeEventListener('devicechange', handler)
  }, [permission, recState, refreshDevices])

  const sourceKey = sources.map((s) => `${s.id}:${s.deviceId}`).join('|')
  useEffect(() => {
    if (!engine) return
    let cancelled = false
    void engine.setSources(sources.map((s) => ({ key: s.id, deviceId: s.deviceId }))).then((failed) => {
      if (cancelled) return
      setOpenKeys([...engine.lanes.keys()])
      setError(failed.length > 0 ? 'Could not open one of the selected microphones. It may be in use by another app.' : null)
    })
    return () => { cancelled = true }
  }, [engine, sourceKey]) // eslint-disable-line react-hooks/exhaustive-deps

  async function enterStudio() {
    try {
      await api.patchProject(project.id, { transcribe_model: model, transcribe_language: language || null })
      setStage('studio')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (recState !== 'recording') return
    const id = setInterval(() => setElapsed((performance.now() - (active.current?.startedAt ?? 0)) / 1000), 250)
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => {
      clearInterval(id)
      window.removeEventListener('beforeunload', warn)
    }
  }, [recState])

  function updateUploadIssue() {
    const ups = active.current?.uploaders ?? []
    const failed = ups.find((u) => u.failed)
    if (failed) setUploadIssue(`Part of this take could not be saved: ${failed.failed}`)
    else if (ups.some((u) => u.retrying)) {
      const mb = ups.reduce((n, u) => n + u.pendingBytes, 0) / 1e6
      setUploadIssue(`Can't reach the Darkroom backend. Holding ${mb.toFixed(1)} MB in memory and retrying…`)
    } else setUploadIssue(null)
  }

  async function startTake() {
    if (!engine) return
    setError(null)
    setRecState('starting')
    try {
      const take = await api.createTake(project.id, sources.map((s) => ({ id: s.id, name: s.name.trim() })))
      upsertTake(take)
      const mimeType = pickMimeType()
      const uploaders = sources.map((s) => new ChunkUploader(
        `/api/projects/${project.id}/takes/${take.id}/mic_${s.id}/chunk`, updateUploadIssue))
      const recorders = sources.map((s, i) => {
        const lane = engine.lanes.get(s.id)
        if (!lane) throw new Error(`The microphone for ${s.name || `participant ${i + 1}`} is not open.`)
        const r = new MediaRecorder(lane.stream, { mimeType: mimeType || undefined, audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
        r.ondataavailable = (e) => { if (e.data.size > 0) uploaders[i].push(e.data) }
        return r
      })
      // Start every recorder in the same tick so the tracks line up.
      recorders.forEach((r) => r.start(CHUNK_MS))
      spans.current.push({ start: engine.now, end: null })
      active.current = { takeId: take.id, recorders, uploaders, startedAt: performance.now() }
      setElapsed(0)
      setUploadIssue(null)
      setRecState('recording')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRecState('idle')
      void reloadTakes().catch(() => {})
    }
  }

  async function stopTake() {
    const rec = active.current
    if (!rec) return
    setRecState('stopping')
    await Promise.all(rec.recorders.map((r) => new Promise<void>((resolve) => {
      // A recorder whose mic was unplugged has already stopped on its own.
      if (r.state === 'inactive') return resolve()
      r.onstop = () => resolve()
      r.stop()
    })))
    const span = spans.current[spans.current.length - 1]
    if (span && engine) span.end = engine.now
    // Every chunk must be on disk before the backend closes the files.
    await Promise.all(rec.uploaders.map((u) => u.drain()))
    const lost = rec.uploaders.find((u) => u.failed)
    if (lost) setError(`Part of this take could not be saved: ${lost.failed}`)
    try {
      upsertTake(await api.stopTake(project.id, rec.takeId))
    } catch (err) {
      setError(`Could not finish saving the take (${err instanceof Error ? err.message : err}). `
        + 'What was saved will be recovered the next time Darkroom starts.')
    }
    active.current = null
    updateUploadIssue()
    setRecState('idle')
  }

  // ── Takes strip actions ────────────────────────────────────────────────────

  async function reorder(order: string[]) {
    setTakes((prev) => order.map((id) => prev.find((t) => t.id === id)!))
    try {
      await api.reorderTakes(project.id, order)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      void reloadTakes()
    }
  }

  async function deleteTake(take: Take, position: number) {
    if (!window.confirm(`Delete take ${position}? Its recording will be permanently removed.`)) return
    await api.deleteTake(project.id, take.id)
    setTakes((prev) => prev.filter((t) => t.id !== take.id))
  }

  async function retryTranscription(take: Take) {
    await api.retryTakeTranscription(project.id, take.id)
    upsertTake({ ...take, transcription: { status: 'pending', percent: 0 } })
  }

  async function keepRecovered(take: Take) {
    upsertTake(await api.keepTake(project.id, take.id))
  }

  // ── Finish & edit: waits for any take still transcribing ─────────────────────

  const readyTakes = takes.filter((t) => t.status === 'ready')
  const waitingFor = readyTakes.filter((t) => t.transcription.status !== 'done')

  useEffect(() => {
    if (!finishing || assembling.current) return
    if (readyTakes.some((t) => t.transcription.status === 'error')) {
      setFinishing(false)
      setError('A take could not be transcribed. Retry it (click its ⚠) or delete it, then finish again.')
      return
    }
    if (waitingFor.length > 0) return
    assembling.current = true
    api.finishRecording(project.id)
      .then((proj) => {
        engine?.close()
        onFinished(proj)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setFinishing(false)
      })
      .finally(() => { assembling.current = false })
  }, [finishing, takes]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleBack() {
    if (recState !== 'idle') {
      if (!window.confirm('Stop recording and leave the studio? The take so far will be kept.')) return
      await stopTake()
    }
    onBack()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (stage === 'sources') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 16px' }}>
        <div style={{ width: '100%', maxWidth: 560, background: 'var(--bg-card)', borderRadius: 12, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <button onClick={() => { void handleBack() }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18 }}>←</button>
            <h2 style={{ fontWeight: 600 }}>{project.name}</h2>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· Choose microphones</span>
          </div>
          <SourcePicker
            engine={engine}
            devices={devices}
            sources={sources}
            onSourcesChange={setSources}
            usedIds={takes.flatMap((t) => t.participants)}
            language={language}
            model={model}
            onLanguageChange={setLanguage}
            onModelChange={setModel}
            permission={permission}
            onEnable={() => { void enableMics() }}
            openKeys={openKeys}
            error={error}
            onEnter={() => { void enterStudio() }}
          />
        </div>
      </div>
    )
  }

  const recording = recState === 'recording'
  const recovered = takes.filter((t) => t.recovered)
  const deviceLabel = (id: string) => devices.find((d) => d.deviceId === id)?.label ?? ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 16px', height: 48, flexShrink: 0,
        background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)',
      }}>
        <button onClick={() => { void handleBack() }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18 }}>←</button>
        <span style={{ fontWeight: 600 }}>{project.name}</span>
        {recState === 'idle' && (
          <button
            onClick={() => setStage('sources')}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 6, padding: '3px 10px', fontSize: 12 }}
          >
            Microphones
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontSize: 15, fontWeight: 600 }}>
          {recording && <><span style={{ color: 'var(--accent)' }}>● REC</span> {formatElapsed(elapsed)}</>}
          {recState === 'stopping' && <span style={{ color: 'var(--text-muted)' }}>Saving take…</span>}
          {recState === 'starting' && <span style={{ color: 'var(--text-muted)' }}>Starting…</span>}
          {recState === 'idle' && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Ready</span>}
        </span>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 12px' }}>
        {engine && (
          <WaveformLanes
            engine={engine}
            spans={spans}
            lanes={sources.map((s, i) => ({ key: s.id, name: s.name.trim() || `Participant ${i + 1}`, device: deviceLabel(s.deviceId) }))}
          />
        )}
        {uploadIssue && <p style={{ color: '#eb3', fontSize: 12, marginTop: 8 }}>{uploadIssue}</p>}
      </div>

      <div style={{ flexShrink: 0, padding: '12px 24px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
        {recovered.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: '#eb3' }}>
              Take {takes.indexOf(t) + 1} ({formatElapsed(t.duration)}) was recovered after Darkroom closed while recording.
            </span>
            <button onClick={() => { void keepRecovered(t) }} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '2px 10px', fontSize: 12 }}>Keep</button>
            <button onClick={() => { void deleteTake(t, takes.indexOf(t) + 1) }} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 6, padding: '2px 10px', fontSize: 12 }}>Delete</button>
          </div>
        ))}

        <TakesStrip
          takes={takes}
          recordingElapsed={elapsed}
          locked={recState !== 'idle' || finishing}
          onReorder={(order) => { void reorder(order) }}
          onDelete={(t, n) => { void deleteTake(t, n) }}
          onRetry={(t) => { void retryTranscription(t) }}
        />

        {error && <p style={{ color: '#f55', fontSize: 12, marginTop: 10 }}>{error}</p>}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 16, position: 'relative' }}>
          {recording || recState === 'stopping' ? (
            <button
              onClick={() => { void stopTake() }}
              disabled={recState === 'stopping'}
              style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 24, padding: '12px 32px', fontWeight: 600, fontSize: 15 }}
            >
              ■ Stop
            </button>
          ) : (
            <button
              onClick={() => { void startTake() }}
              disabled={recState !== 'idle' || finishing || openKeys.length < sources.length}
              style={{ background: 'none', border: '2px solid var(--accent)', color: 'var(--accent)', borderRadius: 24, padding: '10px 30px', fontWeight: 600, fontSize: 15 }}
            >
              ● Record {takes.length > 0 ? 'another take' : ''}
            </button>
          )}
          <div style={{ position: 'absolute', right: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            {finishing && waitingFor.length > 0 && (
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                Opening the editor when {waitingFor.length === 1 ? 'the last take is' : `${waitingFor.length} takes are`} transcribed…{' '}
                <button onClick={() => setFinishing(false)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, padding: 0 }}>
                  Cancel
                </button>
              </span>
            )}
            <button
              onClick={() => { setError(null); setFinishing(true) }}
              disabled={recState !== 'idle' || finishing || readyTakes.length === 0}
              style={{
                background: readyTakes.length > 0 && recState === 'idle' ? 'var(--text)' : 'var(--border)',
                color: 'var(--bg)', border: 'none', borderRadius: 'var(--radius)',
                padding: '10px 18px', fontWeight: 600,
              }}
            >
              {finishing ? 'Finishing…' : 'Finish & edit →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

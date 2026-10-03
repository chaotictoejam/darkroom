/**
 * Recorder — capture one track per microphone, all started together so the
 * resulting files are pre-aligned the same way uploaded tracks must be.
 *
 * Works in any secure context (localhost counts); the desktop app adds the
 * OS-level microphone prompt on macOS via window.darkroom.
 */
import { useEffect, useRef, useState } from 'react'
import { desktop } from '../../desktop'

const MAX_TRACKS = 4

// Voice-grade Opus; ~57 MB per track per hour, which keeps long sessions in memory.
const AUDIO_BITS_PER_SECOND = 128_000

interface Track {
  name: string
  deviceId: string
}

export interface RecordedTrack {
  name: string
  file: File
}

interface Props {
  /** Called with the finished tracks after Stop, and with null when they are discarded. */
  onChange: (tracks: RecordedTrack[] | null) => void
  onRecordingChange?: (recording: boolean) => void
}

type Phase = 'idle' | 'requesting' | 'ready' | 'recording' | 'done'

function pickMimeType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

function openMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // Raw signal: the editor and renderer handle levels, and per-mic DSP
      // would make crosstalk between tracks harder to cut.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export default function Recorder({ onChange, onRecordingChange }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [tracks, setTracks] = useState<Track[]>([{ name: '', deviceId: '' }])
  const [levels, setLevels] = useState<number[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [results, setResults] = useState<(RecordedTrack & { url: string })[]>([])
  const [error, setError] = useState<string | null>(null)

  const streamsRef = useRef<MediaStream[]>([])
  const recordersRef = useRef<MediaRecorder[]>([])
  const chunksRef = useRef<Blob[][]>([])
  const startedAtRef = useRef(0)

  async function refreshDevices() {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    // Chromium lists "default" and "communications" as aliases of a real device;
    // hide them so two tracks can't silently record the same mic.
    const real = all.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    const list = real.length > 0 ? real : all
    setDevices(list)
    setTracks((prev) =>
      prev.map((t) => (list.some((d) => d.deviceId === t.deviceId) ? t : { ...t, deviceId: list[0]?.deviceId ?? '' })),
    )
  }

  async function enableMics() {
    setError(null)
    setPhase('requesting')
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
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('idle')
    }
  }

  // Keep the device list current when mics are plugged in or removed. Not while
  // recording: reassigning a device would reopen the streams under the recorders.
  useEffect(() => {
    if (phase !== 'ready') return
    const md = navigator.mediaDevices
    const handler = () => { void refreshDevices() }
    md.addEventListener('devicechange', handler)
    return () => md.removeEventListener('devicechange', handler)
  }, [phase])

  // Open one stream per track and drive the level meters. The same streams feed
  // the recorders, so this stays open from arming through to Stop.
  const armed = phase === 'ready' || phase === 'recording'
  const deviceKey = tracks.map((t) => t.deviceId).join('|')
  useEffect(() => {
    if (!armed) return
    let cancelled = false
    let raf = 0
    let streams: MediaStream[] = []
    const ctx = new AudioContext()

    ;(async () => {
      const settled = await Promise.allSettled(deviceKey.split('|').map(openMic))
      streams = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      if (cancelled) return
      if (streams.length !== settled.length) {
        setError('Could not open one of the selected microphones. It may be in use by another app.')
        return
      }
      streamsRef.current = streams
      void ctx.resume()
      const analysers = streams.map((s) => {
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(s).connect(analyser)
        return analyser
      })
      const buf = new Float32Array(1024)
      const tick = () => {
        setLevels(analysers.map((a) => {
          a.getFloatTimeDomainData(buf)
          let peak = 0
          for (const v of buf) peak = Math.max(peak, Math.abs(v))
          return peak
        }))
        raf = requestAnimationFrame(tick)
      }
      tick()
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      streamsRef.current = []
      setLevels([])
      void ctx.close()
    }
  }, [armed, deviceKey])

  useEffect(() => {
    onRecordingChange?.(phase === 'recording')
  }, [phase, onRecordingChange])

  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => setElapsed((performance.now() - startedAtRef.current) / 1000), 250)
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => {
      clearInterval(id)
      window.removeEventListener('beforeunload', warn)
    }
  }, [phase])

  useEffect(() => () => results.forEach((r) => URL.revokeObjectURL(r.url)), [results])

  function start() {
    const streams = streamsRef.current
    if (streams.length !== tracks.length) return
    setError(null)
    const mimeType = pickMimeType()
    chunksRef.current = streams.map(() => [])
    const recorders = streams.map((s, i) => {
      const r = new MediaRecorder(s, { mimeType: mimeType || undefined, audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
      r.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current[i].push(e.data) }
      return r
    })
    // Start every recorder in the same tick so the tracks line up.
    recorders.forEach((r) => r.start(1000))
    recordersRef.current = recorders
    startedAtRef.current = performance.now()
    setElapsed(0)
    setPhase('recording')
  }

  async function stop() {
    const recorders = recordersRef.current
    await Promise.all(recorders.map((r) => new Promise<void>((resolve) => {
      // A recorder whose mic was unplugged has already stopped on its own.
      if (r.state === 'inactive') return resolve()
      r.onstop = () => resolve()
      r.stop()
    })))
    recordersRef.current = []
    const out = tracks.map((t, i) => {
      const name = t.name.trim() || `Participant ${i + 1}`
      const type = recorders[i].mimeType || 'audio/webm'
      const ext = type.startsWith('audio/ogg') ? '.ogg' : '.webm'
      const file = new File(chunksRef.current[i], `${name}${ext}`, { type })
      return { name, file, url: URL.createObjectURL(file) }
    })
    chunksRef.current = []
    setResults(out)
    setPhase('done')
    onChange(out.map(({ name, file }) => ({ name, file })))
  }

  function discard() {
    setResults([])
    setPhase('ready')
    onChange(null)
  }

  function updateTrack(i: number, patch: Partial<Track>) {
    setTracks((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
  }

  function addTrack() {
    const unused = devices.find((d) => !tracks.some((t) => t.deviceId === d.deviceId))
    setTracks((prev) => [...prev, { name: '', deviceId: unused?.deviceId ?? devices[0]?.deviceId ?? '' }])
  }

  const ids = tracks.map((t) => t.deviceId)
  const hasDuplicateMic = new Set(ids).size !== ids.length
  const locked = phase === 'recording' || phase === 'done'

  const mutedText = { color: 'var(--text-muted)', fontSize: 12 }
  const secondaryButton = {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: 'var(--radius)', padding: '8px 14px',
  }

  if (phase === 'idle' || phase === 'requesting') {
    return (
      <div>
        <p style={{ ...mutedText, marginBottom: 12 }}>
          Record each participant on their own microphone. Tracks start together, so they come out aligned and ready to transcribe.
        </p>
        {error && <p style={{ color: '#f55', marginBottom: 12 }}>{error}</p>}
        <button onClick={enableMics} disabled={phase === 'requesting'} style={secondaryButton}>
          {phase === 'requesting' ? 'Waiting for permission…' : '🎙 Enable microphones'}
        </button>
      </div>
    )
  }

  return (
    <div>
      {tracks.map((t, i) => {
        const level = Math.min(1, levels[i] ?? 0)
        const result = results[i]
        return (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                placeholder={`Participant ${i + 1}`}
                value={t.name}
                disabled={locked}
                onChange={(e) => updateTrack(i, { name: e.target.value })}
                style={{ flex: 1 }}
              />
              <select
                value={t.deviceId}
                disabled={locked}
                onChange={(e) => updateTrack(i, { deviceId: e.target.value })}
                style={{ flex: 2, minWidth: 0 }}
              >
                {devices.map((d, di) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${di + 1}`}</option>
                ))}
              </select>
              {tracks.length > 1 && !locked && (
                <button
                  onClick={() => setTracks((prev) => prev.filter((_, idx) => idx !== i))}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)' }}
                >✕</button>
              )}
            </div>
            {result ? (
              <audio controls src={result.url} style={{ width: '100%', height: 32, marginTop: 6 }} />
            ) : (
              <div style={{ height: 4, marginTop: 6, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${level * 100}%`,
                  background: level > 0.95 ? '#f55' : level > 0.7 ? '#eb3' : '#4c8',
                  transition: 'width 60ms linear',
                }} />
              </div>
            )}
          </div>
        )
      })}

      {!locked && tracks.length < MAX_TRACKS && (
        <button
          onClick={addTrack}
          style={{ background: 'none', border: '1px dashed var(--border)', color: 'var(--text-muted)', borderRadius: 'var(--radius)', padding: '6px 14px', width: '100%', marginBottom: 10 }}
        >
          + Add microphone
        </button>
      )}

      {hasDuplicateMic && !locked && (
        <p style={{ color: '#eb3', fontSize: 12, marginBottom: 10 }}>
          Two tracks use the same microphone, so they will record identical audio.
        </p>
      )}
      {error && <p style={{ color: '#f55', marginBottom: 10 }}>{error}</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {phase === 'ready' && (
          <button
            onClick={start}
            disabled={levels.length !== tracks.length}
            style={{ ...secondaryButton, borderColor: 'var(--accent)', color: 'var(--accent)' }}
          >
            ● Start recording
          </button>
        )}
        {phase === 'recording' && (
          <>
            <button onClick={() => { void stop() }} style={{ ...secondaryButton, background: 'var(--accent)', border: 'none', color: '#fff' }}>
              ■ Stop
            </button>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'var(--accent)' }}>●</span> {formatElapsed(elapsed)}
            </span>
          </>
        )}
        {phase === 'done' && (
          <>
            <span style={mutedText}>Recorded {formatElapsed(elapsed)}</span>
            <button onClick={discard} style={secondaryButton}>Discard & re-record</button>
          </>
        )}
      </div>
    </div>
  )
}

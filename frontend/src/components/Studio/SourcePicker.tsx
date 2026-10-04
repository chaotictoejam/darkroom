/**
 * Source picker — one row per microphone with a participant name, the device,
 * and a live level meter, so the user can check it's the right mic before
 * entering the studio. Also sets the transcription language and model.
 */
import type { MicEngine } from './micEngine'
import LevelMeter from './LevelMeter'
import { LANGUAGES, WHISPER_MODELS } from '../../transcriptionOptions'

export const MAX_SOURCES = 4

export interface MicChoice {
  /** Participant id, A–D */
  id: string
  name: string
  deviceId: string
}

interface Props {
  engine: MicEngine | null
  devices: MediaDeviceInfo[]
  sources: MicChoice[]
  onSourcesChange: (sources: MicChoice[]) => void
  /** Participant ids used in earlier takes; a new mic avoids them so it isn't mistaken for that person */
  usedIds: string[]
  language: string
  model: string
  onLanguageChange: (v: string) => void
  onModelChange: (v: string) => void
  permission: 'idle' | 'requesting' | 'granted'
  onEnable: () => void
  openKeys: string[]
  error: string | null
  onEnter: () => void
}

const mutedText = { color: 'var(--text-muted)', fontSize: 12 }
const secondaryButton = {
  background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
  borderRadius: 'var(--radius)', padding: '8px 14px',
}

export default function SourcePicker(props: Props) {
  const { engine, devices, sources, onSourcesChange, usedIds, permission, openKeys, error } = props

  function update(i: number, patch: Partial<MicChoice>) {
    onSourcesChange(sources.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  function add() {
    const free = ['A', 'B', 'C', 'D'].filter((id) => !sources.some((s) => s.id === id))
    const id = free.find((f) => !usedIds.includes(f)) ?? free[0]
    const unused = devices.find((d) => !sources.some((s) => s.deviceId === d.deviceId))
    onSourcesChange([...sources, { id, name: '', deviceId: unused?.deviceId ?? devices[0]?.deviceId ?? '' }])
  }

  const ids = sources.map((s) => s.deviceId)
  const hasDuplicate = new Set(ids).size !== ids.length
  const allOpen = sources.length > 0 && sources.every((s) => openKeys.includes(s.id))

  return (
    <div>
      <p style={{ ...mutedText, marginBottom: 16 }}>
        Record each participant on their own microphone. Every take is saved to disk as it records and
        transcribed as soon as you stop.
      </p>

      {permission !== 'granted' ? (
        <>
          {error && <p style={{ color: '#f55', marginBottom: 12 }}>{error}</p>}
          <button onClick={props.onEnable} disabled={permission === 'requesting'} style={secondaryButton}>
            {permission === 'requesting' ? 'Waiting for permission…' : '🎙 Enable microphones'}
          </button>
        </>
      ) : (
        <>
          {sources.map((s, i) => (
            <div key={s.id} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  placeholder={`Participant ${i + 1}`}
                  value={s.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <select
                  value={s.deviceId}
                  onChange={(e) => update(i, { deviceId: e.target.value })}
                  style={{ flex: 2, minWidth: 0 }}
                >
                  {devices.map((d, di) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${di + 1}`}</option>
                  ))}
                </select>
                {sources.length > 1 && (
                  <button
                    onClick={() => onSourcesChange(sources.filter((_, idx) => idx !== i))}
                    aria-label="Remove microphone"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)' }}
                  >✕</button>
                )}
              </div>
              <div style={{ marginTop: 6 }}>
                {engine && openKeys.includes(s.id)
                  ? <LevelMeter engine={engine} laneKey={s.id} width={480} height={6} />
                  : <span style={mutedText}>Opening microphone…</span>}
              </div>
            </div>
          ))}

          {sources.length < MAX_SOURCES && (
            <button
              onClick={add}
              style={{ background: 'none', border: '1px dashed var(--border)', color: 'var(--text-muted)', borderRadius: 'var(--radius)', padding: '6px 14px', width: '100%', marginBottom: 12 }}
            >
              + Add microphone
            </button>
          )}

          {hasDuplicate && (
            <p style={{ color: '#eb3', fontSize: 12, marginBottom: 12 }}>
              Two participants use the same microphone, so they will record identical audio.
            </p>
          )}

          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <label style={{ flex: 1 }}>
              <span style={{ ...mutedText, display: 'block', marginBottom: 4 }}>Language</span>
              <select value={props.language} onChange={(e) => props.onLanguageChange(e.target.value)} style={{ width: '100%' }}>
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              <span style={{ ...mutedText, display: 'block', marginBottom: 4 }}>Whisper model</span>
              <select value={props.model} onChange={(e) => props.onModelChange(e.target.value)} style={{ width: '100%' }}>
                {WHISPER_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
          </div>

          {error && <p style={{ color: '#f55', marginBottom: 12 }}>{error}</p>}

          <button
            onClick={props.onEnter}
            disabled={!allOpen}
            style={{
              width: '100%', background: allOpen ? 'var(--accent)' : 'var(--border)',
              color: '#fff', border: 'none', borderRadius: 'var(--radius)',
              padding: '12px 0', fontWeight: 600, fontSize: 15,
            }}
          >
            Enter studio →
          </button>
        </>
      )}
    </div>
  )
}

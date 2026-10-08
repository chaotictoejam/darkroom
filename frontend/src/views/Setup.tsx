/**
 * Setup view — the Upload path: name a file per speaker, upload, kick off
 * transcription. Files must already be synced (all start at the same moment).
 * Whether the project is video or audio-only is worked out from the files.
 */
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Project } from '../api/types'
import { LANGUAGES, useWhisperModel, whisperModelOptions } from '../transcriptionOptions'

interface SpeakerSlot {
  name: string
  file: File | null
}

interface Props {
  project: Project
  onBack: () => void
  onProcessing: (project: Project) => void
}

export default function Setup({ project, onBack, onProcessing }: Props) {
  const [name, setName] = useState(project.name)
  const [speakers, setSpeakers] = useState<SpeakerSlot[]>([{ name: '', file: null }])
  const [language, setLanguage] = useState('en')
  const { model, setModel, recommended } = useWhisperModel(language)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Warm up the chosen model while files are picked (only if already downloaded).
  useEffect(() => { if (model) void api.preloadModel(model).catch(() => {}) }, [model])

  function addSpeaker() {
    if (speakers.length < 4) setSpeakers((prev) => [...prev, { name: '', file: null }])
  }

  function removeSpeaker(i: number) {
    setSpeakers((prev) => prev.filter((_, idx) => idx !== i))
  }

  function updateSpeaker(i: number, patch: Partial<SpeakerSlot>) {
    setSpeakers((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  const canStart = speakers.length > 0 && speakers.every((s) => s.file !== null)

  async function handleStart() {
    setError(null)
    setUploading(true)
    try {
      const form = new FormData()
      speakers.forEach((s, i) => {
        form.append('files', s.file!)
        form.append('names', s.name || `Speaker ${i + 1}`)
      })
      form.append('model', model)
      form.append('name', name.trim() || project.name)
      if (language) form.append('language', language)

      // Upload files (Content-Type is set automatically by FormData)
      const res = await fetch(`/api/projects/${project.id}/upload`, { method: 'POST', body: form })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Upload failed')
      const uploaded: Project = await res.json()

      // Kick off transcription
      await api.transcribe(uploaded.id)
      onProcessing({ ...uploaded, status: 'transcribing' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 16px' }}>
      <div style={{ width: '100%', maxWidth: 560, background: 'var(--bg-card)', borderRadius: 12, padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18 }}>←</button>
          <h2 style={{ fontWeight: 600 }}>{name}</h2>
        </div>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
        </label>

        <div style={{ marginBottom: 16 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>
            Files & speakers
          </span>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            One file per speaker (camera or microphone). <strong style={{ color: 'var(--text)' }}>All files must start at the same moment</strong>,
            so they line up without adjusting.
          </p>
          {speakers.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input
                placeholder={`Speaker ${i + 1}`}
                value={s.name}
                onChange={(e) => updateSpeaker(i, { name: e.target.value })}
                style={{ flex: 1 }}
              />
              <input
                type="file"
                accept="video/*,audio/*,.mp4,.mov,.mkv,.avi,.webm,.mp3,.m4a,.wav,.aac,.ogg,.flac,.opus"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file !== undefined) updateSpeaker(i, { file })
                }}
                style={{ flex: 2 }}
              />
              {speakers.length > 1 && (
                <button onClick={() => removeSpeaker(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)' }}>✕</button>
              )}
            </div>
          ))}
          {speakers.length < 4 && (
            <button onClick={addSpeaker} style={{ background: 'none', border: '1px dashed var(--border)', color: 'var(--text-muted)', borderRadius: 'var(--radius)', padding: '6px 14px', width: '100%' }}>
              + Add speaker
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
          <label style={{ flex: 1 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ width: '100%' }}>
              {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Whisper model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: '100%' }}>
              {whisperModelOptions(recommended).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
        </div>

        {error && <p style={{ color: '#f55', marginBottom: 12 }}>{error}</p>}

        <button
          onClick={handleStart}
          disabled={!canStart || uploading}
          style={{
            width: '100%', background: canStart ? 'var(--accent)' : 'var(--border)',
            color: '#fff', border: 'none', borderRadius: 'var(--radius)',
            padding: '12px 0', fontWeight: 600, fontSize: 15,
          }}
        >
          {uploading ? 'Uploading…' : 'Upload & Transcribe'}
        </button>
      </div>
    </div>
  )
}

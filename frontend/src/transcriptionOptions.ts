/** Options for local transcription, shared by Setup (upload) and the recording studio. */
import { useEffect, useState } from 'react'
import { api } from './api/client'

// Used until the backend says which model suits this machine (small on CPU,
// turbo on an NVIDIA GPU; see docs/fast-transcription.md, Phase 0)
const FALLBACK_WHISPER_MODEL = 'small'

const WHISPER_MODELS = [
  { value: 'base',   label: 'base — fastest, least accurate' },
  { value: 'small',  label: 'small — fast and accurate in English' },
  { value: 'medium', label: 'medium — slower' },
  { value: 'turbo',  label: 'turbo — accurate in more languages; fast on a GPU' },
  { value: 'large',  label: 'large — slowest' },
]

/** Model options, with the one recommended for this machine marked. */
export function whisperModelOptions(recommended: string | null) {
  return WHISPER_MODELS.map((m) => (m.value === recommended
    ? { ...m, label: `${m.label} (recommended for this computer)` }
    : m))
}

/**
 * The chosen Whisper model, starting from `initial` (a project's saved choice)
 * or else the backend's default for this machine.
 */
export function useWhisperModel(initial?: string | null) {
  const [model, setModel] = useState(initial ?? '')
  const [recommended, setRecommended] = useState<string | null>(null)
  useEffect(() => {
    api.transcriptionDefaults()
      .then((d) => { setRecommended(d.default_model); setModel((m) => m || d.default_model) })
      .catch(() => setModel((m) => m || FALLBACK_WHISPER_MODEL))
  }, [])
  return { model, setModel, recommended }
}

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: '',   label: 'Auto-detect' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'ru', label: 'Russian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
]

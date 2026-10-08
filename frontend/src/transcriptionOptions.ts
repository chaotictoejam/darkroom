/** Options for local transcription, shared by Setup (upload) and the recording studio. */
import { useEffect, useState } from 'react'
import { api } from './api/client'


const WHISPER_MODELS = [
  { value: 'base',   label: 'base — fastest, least accurate' },
  { value: 'small',  label: 'small — fast and accurate in English' },
  { value: 'medium', label: 'medium — slower' },
  { value: 'turbo',  label: 'turbo — accurate in more languages; fast on a GPU' },
  { value: 'large',  label: 'large — slowest' },
]

/** Model options, with the one recommended for this computer and language marked. */
export function whisperModelOptions(recommended: string | null) {
  return WHISPER_MODELS.map((m) => (m.value === recommended
    ? { ...m, label: `${m.label} (recommended)` }
    : m))
}

/**
 * The chosen Whisper model. Until the user picks one (or a project has one
 * saved in `initial`), it follows the backend's recommendation for this
 * computer and `language` ('' = auto-detect): small for English on a CPU,
 * otherwise turbo (see docs/fast-transcription.md, Phase 0).
 */
export function useWhisperModel(language: string, initial?: string | null) {
  const [model, setModelState] = useState(initial ?? '')
  const [chosen, setChosen] = useState(Boolean(initial))
  const [recommended, setRecommended] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.transcriptionDefaults(language)
      .then((d) => {
        if (cancelled) return
        setRecommended(d.default_model)
        if (!chosen) setModelState(d.default_model)
      })
      .catch(() => {
        // Backend unreachable: the same rule, assuming a CPU
        if (!cancelled && !chosen) setModelState(language === 'en' ? 'small' : 'turbo')
      })
    return () => { cancelled = true }
  }, [language, chosen])
  const setModel = (m: string) => { setChosen(true); setModelState(m) }
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

/** Options for local transcription, shared by Setup (upload) and the recording studio. */
export const DEFAULT_WHISPER_MODEL = 'turbo'

export const WHISPER_MODELS = [
  { value: 'turbo',  label: 'turbo — fast + accurate (recommended)' },
  { value: 'base',   label: 'base — fastest, less accurate' },
  { value: 'small',  label: 'small — fast, decent accuracy' },
  { value: 'medium', label: 'medium — slower, good accuracy' },
  { value: 'large',  label: 'large — best, slowest' },
]

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

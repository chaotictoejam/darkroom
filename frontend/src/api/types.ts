// ── Shared domain types ───────────────────────────────────────────────────────

export interface Progress {
  step: string
  percent: number
  message: string
}

export interface Word {
  word: string
  start: number
  end: number
}

export interface TranscriptSegment {
  speaker_id: string
  speaker_name: string
  start: number
  end: number
  text: string
  words: Word[]
}

export interface Speaker {
  id: string
  name: string
  file: string
  file_path: string
}

export type EDLLayout = 'single' | 'split' | 'pip'

export interface EDLSegment {
  id: string
  start: number
  end: number
  keep: boolean
  camera: string
  layout: EDLLayout
  reason: string | null
}

export interface Clip {
  id: string
  label: string
  start: number
  end: number
  reason: string
}

export interface EDL {
  segments: EDLSegment[]
  clips: Clip[]
}

export interface Render {
  status: 'done' | 'error'
  url: string
  filename: string
}

export type ProjectStatus =
  | 'created'
  | 'recording'
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'analyzing'
  | 'ready'
  | 'rendering'
  | 'error'

/** A deleted time range — from a word-level transcript edit. */
export interface AiStatus {
  provider: 'anthropic' | 'bedrock'
  model: string
  /** Where the transcript is sent when Analyse runs, e.g. "Bedrock in your AWS account (us-east-1)" */
  destination: string
  /** One line on where it's processed and who can see it, shown before Analyse runs */
  detail: string
  configured: boolean
}

export interface WordCut {
  start: number
  end: number
}

/** A muted time range — video is kept but audio is silenced. */
export interface WordMute {
  start: number
  end: number
}

export type ProjectSource = 'upload' | 'record'

/** A person recorded on their own microphone. Ids are A–D, matching speaker ids. */
export interface Participant {
  id: string
  name: string
}

export type TakeTranscriptionStatus = 'none' | 'pending' | 'transcribing' | 'done' | 'error'

export interface Take {
  id: string
  created_at: string
  status: 'recording' | 'finalizing' | 'ready' | 'error'
  participants: string[]
  /** participant id → finalised file inside takes/<id>/ */
  tracks: Record<string, string>
  duration: number
  error: string | null
  /** Finalised on startup after the app closed mid-take; the studio asks whether to keep it. */
  recovered: boolean
  transcription: { status: TakeTranscriptionStatus; percent: number; error?: string | null }
}

export interface TakeBoundary {
  take_id: string
  start: number
  end: number
}

export interface Project {
  id: string
  name: string
  status: ProjectStatus
  project_type: 'video' | 'podcast'
  source: ProjectSource
  participants?: Participant[]
  /** Recorded projects only, in timeline order. */
  takes?: Take[]
  take_boundaries?: TakeBoundary[]
  created_at: string
  speakers: Speaker[]
  transcripts: Record<string, TranscriptSegment[]>
  merged_transcript: TranscriptSegment[]
  edl: EDL | null
  word_cuts: WordCut[]   // manual word-level cuts, separate from AI EDL cuts
  word_mutes: WordMute[] // audio-only mutes — video kept, sound silenced
  renders: Record<string, Render>
  progress: Progress
  transcribe_model?: string
  transcribe_language?: string | null
}

export interface ProjectSummary {
  id: string
  name: string
  status: ProjectStatus
  created_at: string
  source: ProjectSource
  project_type: 'video' | 'podcast'
}

// ── Render request payloads ───────────────────────────────────────────────────

export interface RenderShortParams {
  clips: Clip[]
  subtitle_style?: 'chunk' | 'word' | 'none'
  camera_layout?: 'active' | 'all' | 'single'
  selected_cams?: string[]
  accent_color?: string
  sub_position?: 'auto' | 'top' | 'bottom'
  output_name?: string
  box_opacity?: number
}

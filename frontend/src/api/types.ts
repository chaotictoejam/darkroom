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
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'analyzing'
  | 'ready'
  | 'rendering'
  | 'error'

/** A deleted time range — from a word-level transcript edit. */
export interface WordCut {
  start: number
  end: number
}

export interface Project {
  id: string
  name: string
  status: ProjectStatus
  created_at: string
  speakers: Speaker[]
  transcripts: Record<string, TranscriptSegment[]>
  merged_transcript: TranscriptSegment[]
  edl: EDL | null
  word_cuts: WordCut[]   // manual word-level cuts, separate from AI EDL cuts
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

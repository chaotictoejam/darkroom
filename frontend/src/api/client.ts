/**
 * Typed API client for the Darkroom backend.
 * All requests go to the same origin — Vite proxies /api/* in dev,
 * FastAPI serves everything from the same port in production.
 */
import type { Clip, EDL, Project, ProjectSummary, RenderShortParams } from './types'

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Projects ──────────────────────────────────────────────────────────────────

export const api = {
  status: () => request<{ ffmpeg_available: boolean; anthropic_configured: boolean }>('/api/status'),

  listProjects: () => request<ProjectSummary[]>('/api/projects'),

  createProject: (name: string) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),

  getProject: (id: string) => request<Project>(`/api/projects/${id}`),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  resetEdl: (id: string) =>
    request<Project>(`/api/projects/${id}/reset-edl`, { method: 'POST' }),

  resetProject: (id: string) =>
    request<Project>(`/api/projects/${id}/reset`, { method: 'POST' }),

  // ── Jobs ────────────────────────────────────────────────────────────────────

  transcribe: (id: string) =>
    request<{ message: string }>(`/api/projects/${id}/transcribe`, { method: 'POST' }),

  analyze: (id: string) =>
    request<{ message: string }>(`/api/projects/${id}/analyze`, { method: 'POST' }),

  skipAnalysis: (id: string) =>
    request<Project>(`/api/projects/${id}/skip-analysis`, { method: 'POST' }),

  importEdl: (id: string, edl: EDL) =>
    request<Project>(`/api/projects/${id}/import-edl`, {
      method: 'POST',
      body: JSON.stringify({ edl }),
    }),

  getPrompt: (id: string) =>
    request<{ prompt: string }>(`/api/projects/${id}/prompt`),

  updateEdl: (id: string, edl: EDL) =>
    request<Project>(`/api/projects/${id}/edl`, {
      method: 'PUT',
      body: JSON.stringify(edl),
    }),

  updateTranscriptSegment: (id: string, segIndex: number, text: string) =>
    request<{ ok: boolean; segment: unknown }>(`/api/projects/${id}/transcript/${segIndex}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    }),

  render: (
    id: string,
    targets: string[],
    opts: { camera_layout?: string; cam_order?: string[] } = {},
  ) =>
    request<{ message: string }>(`/api/projects/${id}/render`, {
      method: 'POST',
      body: JSON.stringify({ targets, ...opts }),
    }),

  renderShort: (id: string, params: RenderShortParams) =>
    request<{ message: string }>(`/api/projects/${id}/render-short`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  faceCenters: (id: string) =>
    request<Record<string, [number, number]>>(`/api/projects/${id}/face-centers`),
}

// ── WebSocket progress ────────────────────────────────────────────────────────

export interface ProgressEvent {
  type?: 'ping'
  status?: string
  progress?: { step: string; percent: number; message: string }
}

/**
 * Open a WebSocket to stream progress events for a project job.
 * Returns an unsubscribe function.
 */
export function subscribeToProgress(
  projectId: string,
  onEvent: (evt: ProgressEvent) => void,
): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${protocol}://${window.location.host}/api/ws/${projectId}`)

  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as ProgressEvent)
    } catch {
      // ignore malformed frames
    }
  }

  return () => ws.close()
}

export { ApiError }

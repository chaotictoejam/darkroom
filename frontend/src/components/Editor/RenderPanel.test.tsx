import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RenderPanel from './RenderPanel'
import { api } from '../../api/client'
import type { Project } from '../../api/types'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Ep 1',
    status: 'ready',
    project_type: 'video',
    has_video: true,
    source: 'upload',
    created_at: '2026-01-01T00:00:00Z',
    speakers: [{ id: 'A', name: 'A', file: 'cam_A.mp4', file_path: '/tmp/cam_A.mp4' }],
    transcripts: {},
    merged_transcript: [],
    edl: { segments: [], clips: [] },
    word_cuts: [],
    word_mutes: [],
    timeline_splits: [],
    renders: {},
    progress: { step: 'done', percent: 100, message: '' },
    ...overrides,
  } as Project
}

describe('RenderPanel', () => {
  beforeEach(() => {
    vi.spyOn(api, 'patchProject').mockImplementation(async (id, patch) =>
      project({ id, ...(patch as Partial<Project>) }),
    )
  })

  it('exports video by default', () => {
    render(<RenderPanel project={project()} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Render Full Edit' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Export MP3' })).toBeNull()
  })

  it('turns a video project into an audio-only one', async () => {
    const onChange = vi.fn()
    render(<RenderPanel project={project()} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Audio only' }))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(api.patchProject).toHaveBeenCalledWith('p1', { project_type: 'podcast' })
    expect(onChange.mock.calls[0][0].project_type).toBe('podcast')
  })

  it('offers MP3 and WAV export, and the way back to video, in audio-only mode', async () => {
    const onChange = vi.fn()
    render(<RenderPanel project={project({ project_type: 'podcast' })} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Export MP3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export WAV' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Render Full Edit' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Video' }))

    await waitFor(() => expect(api.patchProject).toHaveBeenCalledWith('p1', { project_type: 'video' }))
  })

  it('hides the switch when the media has no video track', () => {
    render(<RenderPanel project={project({ project_type: 'podcast', has_video: false })} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Audio only' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Export MP3' })).toBeTruthy()
  })

  it('shows the switch on projects from before the has_video flag', () => {
    render(<RenderPanel project={project({ has_video: null })} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Audio only' })).toBeTruthy()
  })

  it('hides the switch on audio-only projects from before the has_video flag', () => {
    render(<RenderPanel project={project({ project_type: 'podcast', has_video: null })} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Video' })).toBeNull()
  })

  it('reports a refused switch instead of changing the project', async () => {
    vi.spyOn(api, 'patchProject').mockRejectedValue(new Error('Nope'))
    const onChange = vi.fn()
    render(<RenderPanel project={project()} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Audio only' }))

    await waitFor(() => expect(screen.getByText('Nope')).toBeTruthy())
    expect(onChange).not.toHaveBeenCalled()
  })
})

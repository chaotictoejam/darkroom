import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MusicPanel from './MusicPanel'
import { api } from '../../api/client'
import type { LibraryTrack, Project, SoundCue } from '../../api/types'

const theme = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 't1', name: 'Opening Theme', file: 'music/t1.flac',
  duration: 95, loudness: -12, added_at: '2026-01-01T00:00:00Z', ...over,
})

const cue = (over: Partial<SoundCue> = {}): SoundCue => ({
  id: 'c1', library_id: 't1', track: 'music', kind: 'bed', at: 30, until: null,
  length: null, gain_db: -14, duck: true, duck_db: -9, loop: true,
  fade_in: 1, fade_out: 2, ...over,
})

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Ep 1',
    status: 'ready',
    group: '',
    project_type: 'podcast',
    has_video: false,
    source: 'record',
    created_at: '2026-01-01T00:00:00Z',
    speakers: [],
    transcripts: {},
    merged_transcript: [],
    edl: { segments: [], clips: [] },
    word_cuts: [],
    word_mutes: [],
    timeline_splits: [],
    sound_tracks: [{ id: 'music', name: 'Music', gain_db: 0, muted: false }],
    sound_cues: [],
    renders: {},
    progress: { step: 'done', percent: 100, message: '' },
    ...overrides,
  } as Project
}

function renderPanel(props: Partial<Parameters<typeof MusicPanel>[0]> = {}) {
  const onCuesChange = vi.fn()
  const onSelectCue = vi.fn()
  const onLibraryChange = vi.fn()
  render(
    <MusicPanel
      project={project()} currentTime={42} duration={600} keptRanges={[]} library={[theme()]}
      loading={false} onLibraryChange={onLibraryChange} selectedCueId={null}
      onSelectCue={onSelectCue} onCuesChange={onCuesChange} {...props}
    />,
  )
  return { onCuesChange, onSelectCue, onLibraryChange }
}

describe('MusicPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })

  it('says the library is shared and stays on the machine', () => {
    renderPanel()
    expect(screen.getByText(/Shared by every project and kept on this computer/)).toBeTruthy()
    expect(screen.getByText(/music you have the rights to use/)).toBeTruthy()
  })

  it('lists the library with each track’s length', () => {
    renderPanel()
    expect(screen.getByText('Opening Theme')).toBeTruthy()
    expect(screen.getByText('1:35')).toBeTruthy()
  })

  it('invites a first import when the library is empty', () => {
    renderPanel({ library: [] })
    expect(screen.getByText(/Empty\. Add an intro/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Intro' })).toBeNull()
  })

  it('says so while the library is loading', () => {
    renderPanel({ library: [], loading: true })
    expect(screen.getByText('Reading the library…')).toBeTruthy()
  })

  it('places a bed at the playhead', () => {
    const { onCuesChange, onSelectCue } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Bed here' }))

    const [cues] = onCuesChange.mock.calls[0]
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ library_id: 't1', kind: 'bed', at: 42, duck: true })
    expect(onSelectCue).toHaveBeenCalledWith(cues[0].id)
  })

  it('pins an intro to the start whatever the playhead is', () => {
    const { onCuesChange } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Intro' }))
    expect(onCuesChange.mock.calls[0][0][0]).toMatchObject({ kind: 'intro', at: 0 })
  })

  it('keeps the cues it already has when adding one', () => {
    const existing = cue()
    const { onCuesChange } = renderPanel({ project: project({ sound_cues: [existing] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Outro' }))
    expect(onCuesChange.mock.calls[0][0]).toHaveLength(2)
    expect(onCuesChange.mock.calls[0][0][0]).toBe(existing)
  })

  it('shows a placed cue with its level, and nothing to tweak until it is opened', () => {
    renderPanel({ project: project({ sound_cues: [cue()] }) })
    const row = screen.getByRole('button', { expanded: false })
    expect(row.textContent).toContain('Opening Theme')
    expect(row.textContent).toContain('Bed')
    expect(screen.getByText('-14 dB')).toBeTruthy()
    expect(screen.queryByLabelText(/Level under the voice/)).toBeNull()
  })

  it('opens a cue when it is the selected one', () => {
    renderPanel({ project: project({ sound_cues: [cue()] }), selectedCueId: 'c1' })
    expect(screen.getByText(/Level under the voice/)).toBeTruthy()
    expect(screen.getByText(/How far down/)).toBeTruthy()
  })

  it('turns the music down under the voice', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue()] }), selectedCueId: 'c1',
    })
    const sliders = screen.getAllByRole('slider')

    fireEvent.change(sliders[0], { target: { value: '-24' } })

    expect(onCuesChange.mock.calls[0][0][0].gain_db).toBe(-24)
  })

  it('changes how far the music ducks', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue()] }), selectedCueId: 'c1',
    })
    fireEvent.change(screen.getAllByRole('slider')[1], { target: { value: '-18' } })
    expect(onCuesChange.mock.calls[0][0][0].duck_db).toBe(-18)
  })

  it('hides the duck depth when ducking is off', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue({ duck: false })] }), selectedCueId: 'c1',
    })
    expect(screen.queryByText(/How far down/)).toBeNull()

    fireEvent.click(screen.getByLabelText(/Duck while anyone is talking/))

    expect(onCuesChange.mock.calls[0][0][0].duck).toBe(true)
  })

  it('sets looping and the fades', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue()] }), selectedCueId: 'c1',
    })
    fireEvent.click(screen.getByLabelText('Loop'))
    expect(onCuesChange.mock.calls[0][0][0].loop).toBe(false)

    fireEvent.change(screen.getByLabelText('Fade in'), { target: { value: '3' } })
    expect(onCuesChange.mock.calls[1][0][0].fade_in).toBe(3)

    fireEvent.change(screen.getByLabelText('out'), { target: { value: '4' } })
    expect(onCuesChange.mock.calls[2][0][0].fade_out).toBe(4)
  })

  it('shows which of the three endings a bed is using', () => {
    renderPanel({ project: project({ sound_cues: [cue({ until: null, loop: true })] }), selectedCueId: 'c1' })
    expect(screen.getByRole('button', { name: 'End of episode', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Track runs out', pressed: false })).toBeTruthy()
    expect(screen.getByText(/Runs to the last word/)).toBeTruthy()
  })

  it('stops a bed when its file runs out', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue({ until: null, loop: true })] }), selectedCueId: 'c1',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Track runs out' }))
    expect(onCuesChange.mock.calls[0][0][0]).toMatchObject({ until: null, loop: false })
  })

  it('ends a bed at the playhead', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue({ at: 10, until: null })] }), selectedCueId: 'c1',
      currentTime: 95,
    })
    fireEvent.click(screen.getByRole('button', { name: 'At the playhead' }))
    expect(onCuesChange.mock.calls[0][0][0]).toMatchObject({ until: 95, loop: true })
  })

  it('says where a bed with an end stops, and that it can be moved', () => {
    renderPanel({ project: project({ sound_cues: [cue({ until: 90 })] }), selectedCueId: 'c1' })
    expect(screen.getByRole('button', { name: 'At the playhead', pressed: true })).toBeTruthy()
    expect(screen.getByText(/Stops at 01:30/)).toBeTruthy()
  })

  it('puts a bed back to running under the whole episode', () => {
    const { onCuesChange } = renderPanel({
      project: project({ sound_cues: [cue({ until: 90, loop: false })] }), selectedCueId: 'c1',
    })
    fireEvent.click(screen.getByRole('button', { name: 'End of episode' }))
    expect(onCuesChange.mock.calls[0][0][0]).toMatchObject({ until: null, loop: true })
  })

  it('does not offer an ending for an intro, which is pinned to the start', () => {
    renderPanel({
      project: project({ sound_cues: [cue({ kind: 'intro' })] }), selectedCueId: 'c1',
    })
    expect(screen.queryByRole('group', { name: 'Where the bed ends' })).toBeNull()
  })

  it('removes a cue', () => {
    const { onCuesChange, onSelectCue } = renderPanel({
      project: project({ sound_cues: [cue()] }), selectedCueId: 'c1',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Opening Theme' }))
    expect(onCuesChange).toHaveBeenCalledWith([])
    expect(onSelectCue).toHaveBeenCalledWith(null)
  })

  it('warns about a cue whose library track is gone', () => {
    renderPanel({
      project: project({ sound_cues: [cue({ library_id: 'gone' })] }), selectedCueId: 'c1',
    })
    expect(screen.getByText(/no longer in the library/)).toBeTruthy()
  })

  it('mutes every cue at once without removing them', () => {
    const { onCuesChange } = renderPanel({ project: project({ sound_cues: [cue()] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    const [cues, tracks] = onCuesChange.mock.calls[0]
    expect(cues).toHaveLength(1)
    expect(tracks[0].muted).toBe(true)
  })

  it('says the preview is the mix for an audio-only project', () => {
    renderPanel({ project: project({ sound_cues: [cue()] }) })
    expect(screen.getByText(/what you hear is what exports/)).toBeTruthy()
  })

  it('says cues are mixed into every export for a video project', () => {
    renderPanel({ project: project({ project_type: 'video', sound_cues: [cue()] }) })
    expect(screen.getByText(/mixed into the preview and every export/)).toBeTruthy()
  })

  it('imports files into the library', async () => {
    vi.spyOn(api, 'importMusic').mockResolvedValue({
      added: [theme({ id: 't2', name: 'New Loop' })],
      errors: [],
      tracks: [theme(), theme({ id: 't2', name: 'New Loop' })],
    })
    const { onLibraryChange } = renderPanel()

    const input = screen.getByLabelText('Add music files to the library')
    fireEvent.change(input, { target: { files: [new File(['x'], 'New Loop.mp3')] } })

    await waitFor(() => expect(onLibraryChange).toHaveBeenCalled())
    expect(onLibraryChange.mock.calls[0][0]).toHaveLength(2)
  })

  it('reports a file it could not import', async () => {
    vi.spyOn(api, 'importMusic').mockResolvedValue({
      added: [], errors: [{ name: 'notes.txt', error: 'not an audio file' }], tracks: [theme()],
    })
    renderPanel()

    fireEvent.change(screen.getByLabelText('Add music files to the library'),
      { target: { files: [new File(['x'], 'notes.txt')] } })

    expect(await screen.findByText(/notes.txt: not an audio file/)).toBeTruthy()
  })

  it('reports a failed import', async () => {
    vi.spyOn(api, 'importMusic').mockRejectedValue(new Error('ffmpeg not found'))
    renderPanel()

    fireEvent.change(screen.getByLabelText('Add music files to the library'),
      { target: { files: [new File(['x'], 'a.mp3')] } })

    expect(await screen.findByText('ffmpeg not found')).toBeTruthy()
  })

  it('does nothing when the file picker is cancelled', () => {
    const spy = vi.spyOn(api, 'importMusic')
    renderPanel()
    fireEvent.change(screen.getByLabelText('Add music files to the library'), { target: { files: [] } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('removes a track from the library everywhere', async () => {
    vi.spyOn(api, 'deleteMusic').mockResolvedValue({ ok: true })
    const { onLibraryChange } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Opening Theme from the library' }))

    await waitFor(() => expect(onLibraryChange).toHaveBeenCalledWith([]))
  })

  it('reports a library delete that failed', async () => {
    vi.spyOn(api, 'deleteMusic').mockRejectedValue(new Error('in use'))
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Opening Theme from the library' }))
    expect(await screen.findByText('in use')).toBeTruthy()
  })

  it('listens to a track and stops it again', () => {
    renderPanel()
    const play = screen.getByRole('button', { name: 'Listen to Opening Theme' })

    fireEvent.click(play)
    expect(screen.getByRole('button', { name: 'Stop Opening Theme' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop Opening Theme' }))
    expect(screen.getByRole('button', { name: 'Listen to Opening Theme' })).toBeTruthy()
  })

  it('picks which track the buttons place', () => {
    const { onCuesChange } = renderPanel({ library: [theme(), theme({ id: 't2', name: 'Stinger' })] })

    fireEvent.click(screen.getByRole('button', { name: 'Stinger' }))
    fireEvent.click(screen.getByRole('button', { name: 'Effect here' }))

    expect(onCuesChange.mock.calls[0][0][0]).toMatchObject({ library_id: 't2', kind: 'sfx' })
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LibraryTrack, SoundCue } from '../../api/types'
import MusicLane from './MusicLane'
import { cueBlocks, type CueBlock } from './musicCues'

// 1 s = 10% of the track
const toLeft = (t: number) => `${t * 10}%`
const toWidth = (dt: number) => `${dt * 10}%`

const track = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 't1', name: 'Late Afternoon Loop', file: 'music/t1.flac',
  duration: 30, loudness: -14, added_at: '', ...over,
})

const cue = (over: Partial<SoundCue> = {}): SoundCue => ({
  id: 'c1', library_id: 't1', track: 'music', kind: 'bed', at: 2, until: 8,
  length: null, gain_db: -14, duck: true, duck_db: -9, loop: true,
  fade_in: 1, fade_out: 2, ...over,
})

function renderLane(blocks: CueBlock[], props: Partial<Parameters<typeof MusicLane>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onMovePointerDown: vi.fn(),
    onTrimPointerDown: vi.fn(),
  }
  render(
    <MusicLane
      blocks={blocks} bottom={0} height={24} name="Music" muted={false}
      pxPerSec={100} toLeft={toLeft} toWidth={toWidth} inView={() => true}
      selectedId={null} {...handlers} {...props}
    />,
  )
  return handlers
}

const blocksFor = (cues: SoundCue[], library = [track()]) =>
  cueBlocks(cues, library, [], 30)

const block = (name = /Late Afternoon Loop/) => screen.getByRole('button', { name })

describe('MusicLane', () => {
  it('names the sound track it shows', () => {
    renderLane([])
    expect(screen.getByText('Music')).toBeTruthy()
  })

  it('says when the track is muted', () => {
    renderLane([], { muted: true })
    expect(screen.getByText('Music · muted')).toBeTruthy()
  })

  it('places a block over the cue’s span', () => {
    renderLane(blocksFor([cue({ at: 2, until: 8 })]))
    expect(block().style.left).toBe('20%')
    expect(block().style.width).toBe('60%')
  })

  it('labels the block and says what the cue does', () => {
    renderLane(blocksFor([cue()]))
    expect(block().textContent).toContain('Late Afternoon Loop')
    expect(block().title).toContain('ducks -9 dB')
  })

  it('drops the label when the block is too narrow for it', () => {
    renderLane(blocksFor([cue({ kind: 'sfx', at: 2, length: 0.3 })]))
    expect(block(/Late Afternoon Loop/).textContent).toBe('')
  })

  it('hides blocks narrower than a few pixels', () => {
    renderLane(blocksFor([cue({ kind: 'sfx', at: 2, length: 0.3 })]), { pxPerSec: 1 })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('hides blocks outside the visible window', () => {
    renderLane(blocksFor([cue()]), { inView: () => false })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('marks the selected cue', () => {
    renderLane(blocksFor([cue()]), { selectedId: 'c1' })
    expect(block().getAttribute('aria-pressed')).toBe('true')
  })

  it('dims a cue whose track is gone and flags it', () => {
    renderLane(blocksFor([cue({ library_id: 'gone' })]))
    const missing = screen.getByRole('button', { name: /Missing track/ })
    expect(missing.textContent).toContain('⚠')
    expect(missing.style.opacity).toBe('0.45')
  })

  it('dims every cue while the track is muted', () => {
    renderLane(blocksFor([cue()]), { muted: true })
    expect(block().style.opacity).toBe('0.45')
  })

  it('reports a grab on the block', () => {
    const { onMovePointerDown } = renderLane(blocksFor([cue()]))
    fireEvent.pointerDown(block())
    expect(onMovePointerDown).toHaveBeenCalledTimes(1)
    expect(onMovePointerDown.mock.calls[0][1].cue.id).toBe('c1')
  })

  it('gives a bed a handle for where it stops', () => {
    const { onTrimPointerDown } = renderLane(blocksFor([cue()]))
    fireEvent.pointerDown(screen.getByTitle(/where the music stops/))
    expect(onTrimPointerDown).toHaveBeenCalledTimes(1)
  })

  it('gives nothing but a bed that handle', () => {
    renderLane(blocksFor([cue({ kind: 'intro' })]))
    expect(screen.queryByTitle(/where the music stops/)).toBeNull()
  })

  it('leaves the handle off a bed too narrow to grab', () => {
    renderLane(blocksFor([cue({ at: 2, until: 2.1 })]), { pxPerSec: 100 })
    expect(screen.queryByTitle(/where the music stops/)).toBeNull()
  })

  it('selects the cue from the keyboard', () => {
    const { onSelect } = renderLane(blocksFor([cue()]))
    fireEvent.keyDown(block(), { key: 'Enter' })
    fireEvent.keyDown(block(), { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenCalledWith('c1')
  })

  it('ignores other keys', () => {
    const { onSelect } = renderLane(blocksFor([cue()]))
    fireEvent.keyDown(block(), { key: 'a' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

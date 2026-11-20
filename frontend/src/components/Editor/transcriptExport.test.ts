import { describe, expect, it } from 'vitest'
import type { EDLSegment, Project, TranscriptSegment } from '../../api/types'
import {
  editedTranscriptText,
  editedWords,
  transcriptBlocks,
  transcriptText,
} from './transcriptExport'

function seg(
  speaker: string,
  words: Array<[string, number, number]>,
): TranscriptSegment {
  return {
    speaker_id: speaker[0],
    speaker_name: speaker,
    start: words[0][1],
    end: words[words.length - 1][2],
    text: words.map((w) => w[0]).join(' '),
    words: words.map(([word, start, end]) => ({ word: ' ' + word, start, end })),
  }
}

function edl(ranges: Array<[number, number, boolean]>): EDLSegment[] {
  return ranges.map(([start, end, keep], i) => ({
    id: `s${i}`, start, end, keep, camera: 'A', layout: 'single' as const, reason: null,
  }))
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'abc12345',
    name: 'Show',
    merged_transcript: [seg('Alice', [['one', 0, 1], ['two', 1, 2], ['three', 2, 3]])],
    word_cuts: [],
    word_mutes: [],
    edl: null,
    ...over,
  } as unknown as Project
}

const full = [{ start: 0, end: 10 }]

describe('editedWords', () => {
  it('keeps every word when nothing is cut', () => {
    const words = editedWords([seg('Alice', [['hi', 0, 1], ['there', 1, 2]])], full, [])
    expect(words.map((w) => w.text)).toEqual(['hi', 'there'])
    expect(words[0]).toMatchObject({ start: 0, end: 1, source: 0, speaker: 'Alice' })
  })

  it('drops words outside the kept ranges and shifts the rest into edited time', () => {
    const words = editedWords(
      [seg('Alice', [['a', 0, 1], ['b', 2, 3], ['c', 4, 5]])],
      [{ start: 0, end: 1.5 }, { start: 3.5, end: 6 }],
      [],
    )
    expect(words.map((w) => w.text)).toEqual(['a', 'c'])
    // "c" starts 0.5s into the second piece, which begins at edited time 1.5
    expect(words[1].start).toBeCloseTo(2.0)
    expect(words[1].end).toBeCloseTo(3.0)
  })

  it('clips a word that straddles the edge of a kept piece', () => {
    const words = editedWords([seg('Alice', [['long', 1, 4]])], [{ start: 0, end: 3 }], [])
    expect(words[0].start).toBeCloseTo(1)
    expect(words[0].end).toBeCloseTo(3)
  })

  it('leaves out muted words, which are silent in the export', () => {
    const words = editedWords(
      [seg('Alice', [['keep', 0, 1], ['damn', 1, 2], ['this', 2, 3]])],
      full,
      [{ start: 1, end: 2 }],
    )
    expect(words.map((w) => w.text)).toEqual(['keep', 'this'])
  })

  it('ignores blank words and segments with no word list', () => {
    const bare = { ...seg('Alice', [['hi', 0, 1]]), words: undefined } as unknown as TranscriptSegment
    const words = editedWords([seg('Alice', [[' ', 0, 1], ['hi', 1, 2]]), bare], full, [])
    expect(words.map((w) => w.text)).toEqual(['hi'])
  })

  it('merges speakers in edited-time order', () => {
    const words = editedWords(
      [seg('Bob', [['second', 2, 3]]), seg('Alice', [['first', 0, 1]])],
      full,
      [],
    )
    expect(words.map((w) => w.text)).toEqual(['first', 'second'])
  })

  it('uses the speaker id when no name is set', () => {
    const noName = { ...seg('Alice', [['hi', 0, 1]]), speaker_name: '' }
    expect(editedWords([noName], full, [])[0].speaker).toBe('A')
  })
})

describe('transcriptBlocks', () => {
  it('joins words of one speaker into a block', () => {
    const blocks = transcriptBlocks(editedWords([seg('Alice', [['a', 0, 1], ['b', 1, 2]])], full, []))
    expect(blocks).toEqual([{ speaker: 'Alice', start: 0, end: 2, text: 'a b' }])
  })

  it('breaks on a speaker change', () => {
    const blocks = transcriptBlocks(
      editedWords([seg('Alice', [['a', 0, 1]]), seg('Bob', [['b', 1, 2]])], full, []),
    )
    expect(blocks.map((b) => b.speaker)).toEqual(['Alice', 'Bob'])
  })

  it('breaks where source material was removed', () => {
    const blocks = transcriptBlocks(
      editedWords(
        [seg('Alice', [['a', 0, 1], ['b', 5, 6]])],
        [{ start: 0, end: 1 }, { start: 5, end: 6 }],
        [],
      ),
    )
    expect(blocks.map((b) => b.text)).toEqual(['a', 'b'])
    expect(blocks[1].start).toBeCloseTo(1)
  })

  it('returns nothing for no words', () => {
    expect(transcriptBlocks([])).toEqual([])
  })
})

describe('transcriptText', () => {
  it('writes a timestamped block per paragraph', () => {
    const text = transcriptText([{ speaker: 'Alice', start: 0, end: 1.5, text: 'hello there' }])
    expect(text).toBe('[00:00:00.000 - 00:00:01.500] Alice\nhello there')
  })

  it('omits an empty speaker name', () => {
    expect(transcriptText([{ speaker: '', start: 0, end: 1, text: 'hi' }])).toBe(
      '[00:00:00.000 - 00:00:01.000]\nhi',
    )
  })
})

describe('editedTranscriptText', () => {
  it('exports the whole transcript when there is no edit', () => {
    expect(editedTranscriptText(project(), 3)).toBe('[00:00:00.000 - 00:00:03.000] Alice\none two three')
  })

  it('falls back to the transcript end when the player has no duration yet', () => {
    expect(editedTranscriptText(project(), 0)).toContain('one two three')
  })

  it('applies the EDL, word cuts and mutes', () => {
    const text = editedTranscriptText(
      project({
        merged_transcript: [seg('Alice', [['one', 0, 1], ['two', 1, 2], ['three', 2, 3], ['four', 3, 4]])],
        edl: { segments: edl([[0, 3, true], [3, 4, false]]) } as Project['edl'],
        word_cuts: [{ start: 1, end: 2 }],
        word_mutes: [{ start: 2, end: 3 }],
      }),
      4,
    )
    // "two" cut, "three" muted, "four" dropped by the EDL
    expect(text).toBe('[00:00:00.000 - 00:00:01.000] Alice\none')
  })

  it('handles an old project with none of the edit fields set', () => {
    expect(editedTranscriptText({ id: 'abc12345', name: 'Show' } as Project, 0)).toBe('')
  })

  it('is empty when nothing survives the edit', () => {
    const text = editedTranscriptText(
      project({ edl: { segments: edl([[0, 3, false]]) } as Project['edl'] }),
      3,
    )
    expect(text).toBe('')
  })
})

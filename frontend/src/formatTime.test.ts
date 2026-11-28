import { describe, expect, it } from 'vitest'
import { formatTimecode, formatTimestamp } from './formatTime'

describe('formatTimecode', () => {
  it.each([
    [0, '00:00.0'],
    [59.9, '00:59.9'],
    [60, '01:00.0'],
    [127.48, '02:07.5'],
    [3630, '60:30.0'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTimecode(seconds)).toBe(expected)
  })
})

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00:00.000'],
    [0.001, '00:00:00.001'],
    [127.4804, '00:02:07.480'],
    [59.9996, '00:01:00.000'],
    [3599.9996, '01:00:00.000'],
    [3661.234, '01:01:01.234'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected)
  })
})

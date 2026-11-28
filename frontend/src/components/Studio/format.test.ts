import { expect, it } from 'vitest'
import { formatElapsed } from './format'

it.each([
  [0, '00:00'],
  [59.999, '00:59'],
  [60, '01:00'],
  [3599.999, '59:59'],
  [3600, '1:00:00'],
  [36_061, '10:01:01'],
])('formats Studio elapsed time at %s seconds as %s', (seconds, expected) => {
  expect(formatElapsed(seconds)).toBe(expected)
})

/**
 * Vitest setup: unmount rendered components and reset browser state between
 * tests, and fill in the DOM APIs jsdom lacks.
 */
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom has PointerEvent but not pointer capture
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

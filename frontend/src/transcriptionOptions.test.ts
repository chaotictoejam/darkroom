import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api/client'
import { LANGUAGES, useWhisperModel, whisperModelOptions } from './transcriptionOptions'

vi.mock('./api/client', () => ({
  api: { transcriptionDefaults: vi.fn() },
}))

const defaults = vi.mocked(api.transcriptionDefaults)
const cpu = (default_model: string) => ({ device: 'cpu' as const, compute_type: 'int8', default_model })

beforeEach(() => { defaults.mockReset() })

describe('transcription options', () => {
  it('marks only the recommended model without mutating later option lists', () => {
    const original = whisperModelOptions(null)
    expect(original.map(({ value }) => value)).toEqual(['base', 'small', 'medium', 'turbo', 'large'])
    expect(whisperModelOptions('turbo')).toEqual(original.map((model) =>
      model.value === 'turbo' ? { ...model, label: `${model.label} (recommended)` } : model,
    ))
    expect(whisperModelOptions('unknown-model')).toEqual(original)
    expect(whisperModelOptions(null)).toEqual(original)
  })

  it('includes exactly one auto-detect choice and unique language codes', () => {
    expect(LANGUAGES.filter(({ value }) => value === '')).toEqual([{ value: '', label: 'Auto-detect' }])
    expect(new Set(LANGUAGES.map(({ value }) => value)).size).toBe(LANGUAGES.length)
  })
})

describe('useWhisperModel', () => {
  it('follows current recommendations until the user explicitly picks a model', async () => {
    defaults.mockImplementation(async (language) => cpu(language === 'en' ? 'small' : 'turbo'))
    const { result, rerender } = renderHook(({ language }) => useWhisperModel(language), {
      initialProps: { language: 'en' },
    })
    await waitFor(() => expect(result.current.model).toBe('small'))
    rerender({ language: 'es' })
    await waitFor(() => expect(result.current.model).toBe('turbo'))

    act(() => result.current.setModel('base'))
    rerender({ language: 'en' })
    await waitFor(() => expect(result.current.recommended).toBe('small'))
    expect(result.current.model).toBe('base')
  })

  it('retains a saved model while still showing the recommended model', async () => {
    defaults.mockResolvedValue(cpu('small'))
    const { result } = renderHook(() => useWhisperModel('en', 'medium'))
    await waitFor(() => expect(result.current.recommended).toBe('small'))
    expect(result.current.model).toBe('medium')
  })

  it.each([
    ['en', 'small'],
    ['', 'turbo'],
  ])('falls back locally for language %j when the backend is unavailable', async (language, expected) => {
    defaults.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useWhisperModel(language))
    await waitFor(() => expect(result.current.model).toBe(expected))
    expect(result.current.recommended).toBeNull()
  })

  it('does not let a stale recommendation override the current language', async () => {
    let resolveEnglish!: (value: ReturnType<typeof cpu>) => void
    defaults.mockImplementation((language) => language === 'en'
      ? new Promise((resolve) => { resolveEnglish = resolve })
      : Promise.resolve(cpu('turbo')),
    )
    const { result, rerender } = renderHook(({ language }) => useWhisperModel(language), {
      initialProps: { language: 'en' },
    })
    rerender({ language: 'es' })
    await waitFor(() => expect(result.current.model).toBe('turbo'))
    await act(async () => { resolveEnglish(cpu('small')) })
    expect(result.current.model).toBe('turbo')
    expect(result.current.recommended).toBe('turbo')
  })
})

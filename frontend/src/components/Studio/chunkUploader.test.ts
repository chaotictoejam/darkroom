import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChunkUploader } from './chunkUploader'

const url = '/api/projects/p/takes/t/mic_1/chunk'
const fetchChunk = vi.fn<typeof fetch>()
const ok = () => new Response(null, { status: 204 })

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  fetchChunk.mockReset()
  vi.stubGlobal('fetch', fetchChunk)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ChunkUploader', () => {
  it('drains immediately when no upload is pending', async () => {
    const uploader = new ChunkUploader(url, vi.fn())
    await uploader.drain()
    expect(uploader.pendingBytes).toBe(0)
    expect(fetchChunk).not.toHaveBeenCalled()
  })

  it('serializes chunks by byte offset and drains only after both are acknowledged', async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    fetchChunk.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const uploader = new ChunkUploader(url, vi.fn())
    const a = new Blob(['abc'])
    const b = new Blob(['defgh'])
    const drained = vi.fn()

    uploader.push(a)
    uploader.push(b)
    const waiting = uploader.drain().then(drained)
    expect(uploader.pendingBytes).toBe(8)
    expect(fetchChunk).toHaveBeenCalledTimes(1)
    expect(fetchChunk).toHaveBeenNthCalledWith(1, `${url}?offset=0`, {
      method: 'POST', body: a, headers: { 'Content-Type': 'application/octet-stream' },
    })

    first.resolve(ok())
    await first.promise
    expect(uploader.pendingBytes).toBe(5)
    expect(fetchChunk).toHaveBeenNthCalledWith(2, `${url}?offset=3`, {
      method: 'POST', body: b, headers: { 'Content-Type': 'application/octet-stream' },
    })
    expect(drained).not.toHaveBeenCalled()

    second.resolve(ok())
    await waiting
    expect(drained).toHaveBeenCalledOnce()
    expect(uploader.pendingBytes).toBe(0)
  })

  it('retries transient network and HTTP errors at the same offset with capped backoff', async () => {
    vi.useFakeTimers()
    fetchChunk.mockResolvedValueOnce(new Response(null, { status: 503 }))
    for (let i = 0; i < 5; i += 1) fetchChunk.mockRejectedValueOnce(new TypeError('offline'))
    fetchChunk.mockResolvedValueOnce(ok())
    const states: boolean[] = []
    const uploader = new ChunkUploader(url, () => { states.push(uploader.retrying) })
    uploader.push(new Blob(['retry me']))
    const waiting = uploader.drain()
    await vi.advanceTimersByTimeAsync(0)

    expect(uploader.retrying).toBe(true)
    expect(uploader.pendingBytes).toBe(8)
    expect(states).toEqual([true])
    for (const [i, delay] of [500, 1000, 2000, 4000, 5000, 5000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fetchChunk).toHaveBeenCalledTimes(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchChunk).toHaveBeenCalledTimes(i + 2)
    }

    await waiting
    expect(fetchChunk.mock.calls.every(([request]) => request === `${url}?offset=0`)).toBe(true)
    expect(uploader.pendingBytes).toBe(0)
    expect(uploader.failed).toBeNull()
    expect(states).toEqual([true, false])
  })

  it.each([
    ['{"detail":"take closed"}', 'take closed'],
    ['not JSON', 'HTTP 409'],
  ])('stops after a permanent refusal (%s) and drops further chunks', async (body, reason) => {
    const onStateChange = vi.fn()
    fetchChunk.mockResolvedValueOnce(new Response(body, { status: 409 }))
    const uploader = new ChunkUploader(url, onStateChange)
    uploader.push(new Blob(['first']))
    uploader.push(new Blob(['queued']))
    await uploader.drain()

    expect(uploader.failed).toBe(reason)
    expect(uploader.pendingBytes).toBe(0)
    expect(onStateChange).toHaveBeenCalledOnce()
    uploader.push(new Blob(['dropped']))
    await uploader.drain()
    expect(fetchChunk).toHaveBeenCalledTimes(1)
    expect(uploader.pendingBytes).toBe(0)
  })
})

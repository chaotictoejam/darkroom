/**
 * Streams one source's MediaRecorder chunks to the backend, in order, as they
 * arrive. Each chunk carries the byte offset it starts at, so the backend can
 * accept a resend (lost response) and refuse a gap. While the backend can't be
 * reached, chunks wait in memory and are retried with backoff.
 */
const MAX_RETRY_DELAY_MS = 5000

export class ChunkUploader {
  private queue: Blob[] = []
  private offset = 0
  private running = false
  private waiters: (() => void)[] = []
  /** Set when the backend refuses the stream for good; later chunks are dropped. */
  failed: string | null = null
  retrying = false

  constructor(private url: string, private onStateChange: () => void) {}

  push(chunk: Blob) {
    if (this.failed) return
    this.queue.push(chunk)
    void this.run()
  }

  /** Bytes recorded but not yet written to disk. */
  get pendingBytes(): number {
    return this.queue.reduce((n, b) => n + b.size, 0)
  }

  /** Resolves once every chunk pushed so far is on disk (or the stream has failed). */
  drain(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private setRetrying(value: boolean) {
    if (this.retrying === value) return
    this.retrying = value
    this.onStateChange()
  }

  private async run() {
    if (this.running) return
    this.running = true
    let delay = 500
    while (this.queue.length > 0 && !this.failed) {
      const chunk = this.queue[0]
      try {
        const res = await fetch(`${this.url}?offset=${this.offset}`, {
          method: 'POST',
          body: chunk,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
        if (res.ok) {
          this.offset += chunk.size
          this.queue.shift()
          delay = 500
          this.setRetrying(false)
          continue
        }
        if (res.status < 500) {
          const body = await res.json().catch(() => ({}))
          this.failed = body.detail ?? `HTTP ${res.status}`
          this.queue = []
          this.onStateChange()
          break
        }
        throw new Error(`HTTP ${res.status}`)
      } catch {
        this.setRetrying(true)
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
      }
    }
    this.running = false
    this.waiters.splice(0).forEach((w) => w())
  }
}

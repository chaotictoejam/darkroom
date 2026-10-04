/**
 * MicEngine — keeps one open stream per microphone source and turns its audio
 * into peaks (one per 10 ms) for the live waveforms and level meters.
 *
 * The streams stay open from the source picker through every take, so sources
 * stay armed and the same streams feed the MediaRecorders.
 */
import workletUrl from './peak-worklet.js?url'

export const PEAKS_PER_SECOND = 100

/** Growable Float32Array: about 1.4 MB per source per hour, so a whole session stays in memory. */
export class PeakBuffer {
  data = new Float32Array(PEAKS_PER_SECOND * 60)
  length = 0

  push(chunk: Float32Array) {
    if (this.length + chunk.length > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, this.length + chunk.length))
      grown.set(this.data.subarray(0, this.length))
      this.data = grown
    }
    this.data.set(chunk, this.length)
    this.length += chunk.length
  }

  /** Highest peak in [from, to), clamped to what has arrived. */
  max(from: number, to: number): number {
    const a = Math.max(0, Math.floor(from))
    const b = Math.min(this.length, Math.ceil(to))
    let m = 0
    for (let i = a; i < b; i++) if (this.data[i] > m) m = this.data[i]
    return m
  }
}

export interface MicSource {
  /** Participant id, A–D */
  key: string
  deviceId: string
}

export interface MicLane {
  key: string
  deviceId: string
  stream: MediaStream
  peaks: PeakBuffer
  /** AudioContext time of peak 0, set when the first peaks arrive. */
  t0: number | null
  /** Latched when a peak reaches full scale; cleared by the user. */
  clipped: boolean
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
}

const CLIP_LEVEL = 0.999

export function openMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // Raw signal: the editor and renderer handle levels, and per-mic DSP
      // would make crosstalk between tracks harder to cut.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
}

export class MicEngine {
  private ctx = new AudioContext()
  private ready = this.ctx.audioWorklet.addModule(workletUrl)
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  readonly lanes = new Map<string, MicLane>()

  /** Seconds on the audio clock, which the peaks are timed against. */
  get now(): number {
    return this.ctx.currentTime
  }

  /**
   * Open a stream for each source (keeping ones whose device hasn't changed)
   * and close the rest. Resolves with the keys whose microphone couldn't be opened.
   * Calls are serialised so quick device changes can't interleave.
   */
  setSources(sources: MicSource[]): Promise<string[]> {
    const run = this.pending.then(() => this.applySources(sources))
    this.pending = run.catch(() => undefined)
    return run
  }

  private async applySources(sources: MicSource[]): Promise<string[]> {
    await this.ready
    if (this.closed) return []
    void this.ctx.resume()

    for (const [key, lane] of this.lanes) {
      if (!sources.some((s) => s.key === key && s.deviceId === lane.deviceId)) this.closeLane(key)
    }

    const failed: string[] = []
    await Promise.all(sources.filter((s) => !this.lanes.has(s.key)).map(async (s) => {
      try {
        const stream = await openMic(s.deviceId)
        if (this.closed) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        this.lanes.set(s.key, this.createLane(s, stream))
      } catch {
        failed.push(s.key)
      }
    }))
    return failed
  }

  private createLane(s: MicSource, stream: MediaStream): MicLane {
    const source = this.ctx.createMediaStreamSource(stream)
    // No outputs: Chromium still runs a worklet node with zero outputs, so it
    // needn't be routed to the speakers.
    const node = new AudioWorkletNode(this.ctx, 'darkroom-peaks', { numberOfInputs: 1, numberOfOutputs: 0 })
    source.connect(node)
    const lane: MicLane = {
      key: s.key, deviceId: s.deviceId, stream, peaks: new PeakBuffer(), t0: null, clipped: false, source, node,
    }
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const chunk = e.data
      if (lane.t0 === null) lane.t0 = this.ctx.currentTime - chunk.length / PEAKS_PER_SECOND
      lane.peaks.push(chunk)
      for (const v of chunk) if (v >= CLIP_LEVEL) lane.clipped = true
    }
    return lane
  }

  private closeLane(key: string) {
    const lane = this.lanes.get(key)
    if (!lane) return
    lane.node.port.onmessage = null
    lane.source.disconnect()
    lane.stream.getTracks().forEach((t) => t.stop())
    this.lanes.delete(key)
  }

  /** Peak level over the last 50 ms, 0–1. */
  level(key: string): number {
    const lane = this.lanes.get(key)
    if (!lane) return 0
    return lane.peaks.max(lane.peaks.length - 5, lane.peaks.length)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const key of [...this.lanes.keys()]) this.closeLane(key)
    void this.ctx.close()
  }
}

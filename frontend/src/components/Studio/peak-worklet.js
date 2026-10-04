/**
 * AudioWorklet: one peak (max |sample|) per 10 ms of audio, posted to the main
 * thread in small batches. Loaded as a bundled file, not a blob URL, because
 * the desktop app's CSP only allows scripts from 'self'.
 */
const PEAKS_PER_SECOND = 100
const BATCH = 4

class PeakProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = Math.round(sampleRate / PEAKS_PER_SECOND)
    this.count = 0
    this.peak = 0
    this.batch = []
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    const n = channels[0].length
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels.length; c++) {
        const v = Math.abs(channels[c][i])
        if (v > this.peak) this.peak = v
      }
      if (++this.count === this.block) {
        this.batch.push(this.peak)
        this.peak = 0
        this.count = 0
      }
    }
    if (this.batch.length >= BATCH) {
      this.port.postMessage(new Float32Array(this.batch))
      this.batch = []
    }
    return true
  }
}

registerProcessor('darkroom-peaks', PeakProcessor)

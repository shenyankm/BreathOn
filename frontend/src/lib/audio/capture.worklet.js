class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new ArrayBuffer(640)
    this.samples = new DataView(this.frame)
    this.index = 0
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (const sample of input) {
      const value = Math.max(-1, Math.min(1, sample))
      this.samples.setInt16(this.index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      if (++this.index === 320) {
        this.port.postMessage(this.frame, [this.frame])
        this.frame = new ArrayBuffer(640)
        this.samples = new DataView(this.frame)
        this.index = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)

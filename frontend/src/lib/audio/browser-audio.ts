export function decodePcm16(encoded: string): Float32Array<ArrayBuffer> {
  const bytes = atob(encoded)
  if (bytes.length % 2) throw new Error('回复音频格式错误')
  const samples = new Float32Array(bytes.length / 2)
  writePcm16(bytes, samples)
  return samples
}

function writePcm16(bytes: string, samples: Float32Array) {
  for (let i = 0; i < samples.length; i++) {
    const value = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8)
    samples[i] = (value >= 32768 ? value - 65536 : value) / 32768
  }
}

export function encodeAudio(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}

export class BrowserAudio {
  private readonly silence = new ArrayBuffer(640)
  private stream?: MediaStream
  private context?: AudioContext
  private capture?: AudioWorkletNode
  private input?: MediaStreamAudioSourceNode
  private silent?: GainNode
  private output?: GainNode
  private playing = new Set<AudioBufferSourceNode>()
  private nextPlayback = 0
  private stopped = false
  muted = false

  async open(onFrame: (buffer: ArrayBuffer) => void, onDeviceLost: () => void) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.stream = stream
    if (this.stopped) { this.stop(); return }
    for (const track of stream.getAudioTracks()) track.onended = () => { if (!this.stopped) { this.stop(); onDeviceLost() } }
    const context = new AudioContext({ sampleRate: 16000 })
    this.context = context
    if (context.sampleRate !== 16000) throw new Error('当前浏览器不支持 16 kHz 音频，请使用桌面 Chrome')
    this.output = context.createGain()
    this.output.connect(context.destination)
    await context.resume()
    await context.audioWorklet.addModule(new URL('./capture.worklet.js', import.meta.url).href)
    if (this.stopped) return
    this.capture = new AudioWorkletNode(context, 'pcm-capture')
    this.capture.port.onmessage = ({ data }) => {
      if (!this.stopped) onFrame(this.muted ? this.silence : data)
    }
    this.input = context.createMediaStreamSource(stream)
    this.silent = context.createGain()
    this.silent.gain.value = 0
    this.input.connect(this.capture).connect(this.silent).connect(context.destination)
  }

  play(encoded: string) {
    const context = this.context
    if (!context || this.stopped) return
    if (context.state !== 'running') throw new Error('音频播放已暂停，请重新开始演练')
    const bytes = atob(encoded)
    if (bytes.length % 2) throw new Error('回复音频格式错误')
    const length = bytes.length / 2
    if (!length) return
    // Providers synthesize faster than playback; bound the whole queued utterance, not arrival speed.
    if (Math.max(0, this.nextPlayback - context.currentTime) + length / 24000 > 60) {
      throw new Error('待播放语音超过一分钟，请重新开始演练')
    }
    const buffer = context.createBuffer(1, length, 24000)
    writePcm16(bytes, buffer.getChannelData(0))
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.output ?? context.destination)
    source.onended = () => { this.playing.delete(source); source.disconnect() }
    const start = Math.max(context.currentTime + 0.03, this.nextPlayback)
    try { source.start(start) }
    catch (error) { source.disconnect(); throw error }
    this.playing.add(source)
    this.nextPlayback = start + buffer.duration
  }

  get isPlaying() { return this.playing.size > 0 }

  interrupt() {
    for (const source of this.playing) { source.onended = null; source.stop(); source.disconnect() }
    this.playing.clear()
    this.nextPlayback = 0
  }

  setOutputMuted(muted: boolean) {
    if (this.output) this.output.gain.value = muted ? 0 : 1
  }

  setMuted(muted: boolean) {
    this.muted = muted
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted
  }

  stop() {
    this.stopped = true
    this.interrupt()
    if (this.capture) { this.capture.port.onmessage = null; this.capture.port.close() }
    this.capture?.disconnect()
    this.input?.disconnect()
    this.silent?.disconnect()
    this.output?.disconnect()
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.stop() }
    if (this.context && this.context.state !== 'closed') void this.context.close()
  }
}

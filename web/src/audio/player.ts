// Plays streamed PCM16 audio without gaps, and can stop instantly when the user interrupts.

export class Player {
  private ctx = new AudioContext();
  private analyser = this.ctx.createAnalyser();
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private levels = new Uint8Array(256);

  constructor(private rate: number) {
    this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
  }

  resume() {
    return this.ctx.resume();
  }

  push(bytes: ArrayBuffer) {
    const pcm = new Int16Array(bytes);
    if (!pcm.length) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, this.rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const at = Math.max(this.ctx.currentTime + 0.04, this.next);
    source.start(at);
    this.next = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  get playing() {
    return this.ctx.currentTime < this.next - 0.02;
  }

  /** 0..1 loudness of what is playing now. */
  level() {
    this.analyser.getByteTimeDomainData(this.levels);
    let sum = 0;
    for (const v of this.levels) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / this.levels.length);
  }

  flush() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.next = 0;
  }

  close() {
    this.flush();
    this.ctx.close().catch(() => {});
  }
}

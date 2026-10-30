// Microphone capture: 16-bit PCM frames at a chosen rate, plus a loudness level.
// Camera capture: a live stream for the preview and JPEG snapshots of it.

export type Frame = { pcm: Int16Array; rms: number };

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  muted = false;

  constructor(
    private rate: number,
    private onFrame: (frame: Frame) => void,
  ) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/capture-worklet.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture", { processorOptions: { rate: this.rate } });
    this.node.port.onmessage = (e) => {
      if (this.muted) return;
      this.onFrame({ pcm: new Int16Array(e.data.pcm), rms: e.data.rms });
    };
    source.connect(this.node);
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }
}

export class Camera {
  stream: MediaStream | null = null;
  private video = document.createElement("video");
  private canvas = document.createElement("canvas");

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } });
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  /** The current frame as base64 JPEG, at most `max` pixels on its long side. */
  snapshot(max = 640): string | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!this.stream || !w || !h) return null;
    const scale = Math.min(1, max / Math.max(w, h));
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.canvas.getContext("2d")?.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL("image/jpeg", 0.75).split(",")[1] || null;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.stream = null;
  }
}

/** Wraps PCM16 mono samples in a WAV file. */
export function wav(chunks: Int16Array[], rate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const c of chunks) {
    new Int16Array(buffer, offset, c.length).set(c);
    offset += c.length * 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Finds where speech starts and stops. Keeps a short pre-roll so the first
 * syllable isn't lost, and adapts to the room's background noise.
 */
export class SpeechDetector {
  private noise = 0.004;
  private loud = 0;
  private quiet = 0;
  private preroll: Int16Array[] = [];
  speaking = false;

  constructor(
    private on: { start(preroll: Int16Array[]): void; frame(pcm: Int16Array): void; end(): void },
    private opts = { prerollFrames: 15, startFrames: 3, endFrames: 40, sensitivity: 1 },
  ) {}

  push({ pcm, rms }: Frame, boost = 1) {
    const threshold = Math.max(0.012, this.noise * 3) * boost * this.opts.sensitivity;
    if (!this.speaking) {
      this.noise = this.noise * 0.98 + Math.min(rms, 0.05) * 0.02;
      this.preroll.push(pcm);
      if (this.preroll.length > this.opts.prerollFrames) this.preroll.shift();
      this.loud = rms > threshold ? this.loud + 1 : 0;
      if (this.loud >= this.opts.startFrames) {
        this.speaking = true;
        this.quiet = 0;
        this.on.start(this.preroll);
        this.preroll = [];
      }
      return;
    }
    this.on.frame(pcm);
    this.quiet = rms > threshold * 0.7 ? 0 : this.quiet + 1;
    if (this.quiet >= this.opts.endFrames) {
      this.speaking = false;
      this.loud = 0;
      this.on.end();
    }
  }

  reset() {
    this.speaking = false;
    this.loud = 0;
    this.quiet = 0;
    this.preroll = [];
  }
}

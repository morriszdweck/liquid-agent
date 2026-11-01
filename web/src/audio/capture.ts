// Microphone capture: 16-bit PCM frames at a chosen rate, plus a loudness level.
// Camera capture: a live stream for the preview and JPEG snapshots of it.

import captureWorkletUrl from "./capture-worklet.ts?worker&url";
import type { Frame } from "./detector";

export type { Frame } from "./detector";
export { SpeechDetector } from "./detector";
export { wav } from "./wav";

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
    try {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(captureWorkletUrl);
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "capture", { processorOptions: { rate: this.rate } });
      this.node.port.onmessage = (e) => {
        if (this.muted) return;
        this.onFrame({ pcm: new Int16Array(e.data.pcm), rms: e.data.rms });
      };
      source.connect(this.node);
    } catch (e) {
      // Don't keep the microphone open when the capture never started.
      this.stop();
      throw e;
    }
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

/** One 20 ms block of microphone audio: 16-bit PCM and its loudness (RMS, 0..1). */
export type Frame = { pcm: Int16Array; rms: number };

export type DetectorEvents = {
  start(preroll: Int16Array[]): void;
  frame(pcm: Int16Array): void;
  end(): void;
};

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
    private on: DetectorEvents,
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

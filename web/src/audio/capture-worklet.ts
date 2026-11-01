// Turns microphone audio into 16-bit PCM at the rate the voice model wants,
// in 20 ms frames, with a loudness value for the level meter and speech detection.
// Vite builds this file into a module of its own; capture.ts loads it into the audio context.

import { Resampler } from "./resample";

// The AudioWorklet globals, which the DOM library does not declare.
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

type CaptureOptions = { processorOptions: { rate: number } };

class Capture extends AudioWorkletProcessor {
  private readonly resampler: Resampler;
  private readonly frame: number;
  private out: Int16Array;
  private fill = 0;
  private energy = 0;

  constructor(options: CaptureOptions) {
    super();
    this.resampler = new Resampler(sampleRate, options.processorOptions.rate);
    this.frame = Math.round(options.processorOptions.rate / 50);
    this.out = new Int16Array(this.frame);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.resampler.process(input, (s) => {
      this.energy += s * s;
      this.out[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.fill === this.frame) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.energy / this.frame) }, [this.out.buffer]);
        this.out = new Int16Array(this.frame);
        this.fill = 0;
        this.energy = 0;
      }
    });
    return true;
  }
}

registerProcessor("capture", Capture);

// Keeps this file a module, so its declarations stay private.
export {};

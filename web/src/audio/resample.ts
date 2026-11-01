// Turns audio at the device's rate into the rate the voice model wants.
//
// Going down in rate without a low-pass filter folds everything above the new
// Nyquist frequency back into the speech band as hiss. Phone and laptop mics
// capture 44.1 or 48 kHz, so that aliasing reached the recognizer on every word.
// A 6th-order Butterworth low-pass runs first; plain linear interpolation then
// picks the samples.

/** Butterworth Q values for the three biquads that make a 6th-order low-pass. */
const BUTTERWORTH_6 = [0.5176380902, 0.7071067812, 1.9318516526];
/** Keep the passband flat up to here, and reject everything from the new Nyquist limit up. */
const CUTOFF_RATIO = 0.45;

type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

/** One RBJ-cookbook low-pass section. */
export function lowpass(sampleRate: number, cutoff: number, q: number): Biquad {
  const w = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function run(f: Biquad, x: number): number {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

/**
 * A stateful resampler. Feed it blocks of device-rate samples in order, and it
 * calls `emit` with target-rate samples. State carries across blocks, so the
 * output does not depend on how the input is split.
 */
export class Resampler {
  /** Input samples per output sample. */
  readonly step: number;
  private readonly sections: Biquad[] = [];
  // Position of the next output in the current block. Output k sits at input position k * step; the
  // interpolation reads the sample before and after the position, so the first output starts at 1.
  private pos = 1;
  private prev = 0;
  private filtered = new Float32Array(0);

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    this.step = inRate / outRate;
    if (this.step > 1) {
      const cutoff = CUTOFF_RATIO * outRate;
      for (const q of BUTTERWORTH_6) this.sections.push(lowpass(inRate, cutoff, q));
    }
  }

  process(input: Float32Array, emit: (sample: number) => void) {
    if (input.length === 0) return;
    if (this.filtered.length < input.length) this.filtered = new Float32Array(input.length);
    const f = this.filtered;
    for (let n = 0; n < input.length; n++) {
      let x = input[n];
      for (const section of this.sections) x = run(section, x);
      f[n] = x;
    }
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const t = this.pos - i;
      const a = i === 0 ? this.prev : f[i - 1];
      const b = f[i];
      emit(Math.max(-1, Math.min(1, a + (b - a) * t)));
      this.pos += this.step;
    }
    this.pos -= input.length;
    this.prev = f[input.length - 1];
  }
}

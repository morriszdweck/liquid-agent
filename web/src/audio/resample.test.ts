import { describe, expect, it } from "vitest";
import { Resampler } from "./resample";

/** A sine at `hz`, `seconds` long, sampled at `rate`. */
function tone(hz: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function run(resampler: Resampler, input: Float32Array, blocks = 128): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += blocks) {
    resampler.process(input.subarray(i, i + blocks), (s) => out.push(s));
  }
  return out;
}

function rms(samples: ArrayLike<number>, skip = 0): number {
  let sum = 0;
  let n = 0;
  for (let i = skip; i < samples.length; i++, n++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

describe("Resampler", () => {
  it("keeps speech-band tones at their level when going from 48 kHz to 16 kHz", () => {
    const input = tone(1000, 48000, 1);
    const out = run(new Resampler(48000, 16000), input);
    expect(out.length).toBe(16000);
    // Skip the filter's start-up transient. A 0.5-amplitude tone has an RMS of 0.354 and should keep it.
    expect(rms(out, 1000)).toBeGreaterThan(0.345);
    expect(rms(out, 1000)).toBeLessThan(0.36);
  });

  it("removes tones above the new Nyquist limit instead of folding them into the speech band", () => {
    // 12 kHz is above 8 kHz, so decimating without a filter would alias it to 4 kHz.
    const alias = tone(12000, 48000, 1);
    const filtered = run(new Resampler(48000, 16000), alias);
    const unfiltered = run(new Resampler(16000, 16000), alias.filter((_, i) => i % 3 === 0));
    expect(rms(unfiltered, 1000)).toBeGreaterThan(0.3); // what the old decimation let through
    expect(rms(filtered, 1000)).toBeLessThan(0.01); // roughly -34 dB or better
  });

  it("gives the same output however the input is split into blocks", () => {
    const input = tone(440, 48000, 0.25);
    for (let i = 0; i < input.length; i++) input[i] += 0.1 * Math.sin(i * 0.37);
    const whole = run(new Resampler(48000, 16000), input, input.length);
    const blocks = run(new Resampler(48000, 16000), input, 128);
    expect(blocks.length).toBe(whole.length);
    let worst = 0;
    for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(whole[i] - blocks[i]));
    expect(worst).toBeLessThan(1e-9);
  });

  it("passes audio straight through when the rates match", () => {
    const input = tone(300, 16000, 0.1);
    const out = run(new Resampler(16000, 16000), input);
    // The newest sample waits for the next block to be interpolated, so the output lags by one sample.
    expect(out.length).toBe(input.length - 1);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(input[i], 6);
  });

  it("clamps the output to the -1..1 range", () => {
    const hot = new Float32Array(480).fill(1.5);
    const out = run(new Resampler(48000, 16000), hot);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(-1);
  });
});

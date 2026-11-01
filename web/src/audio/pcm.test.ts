import { describe, expect, it } from "vitest";
import { alignPcm } from "./pcm";

/** Little-endian PCM16 bytes for the given samples. */
function bytesOf(samples: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return new Uint8Array(view.buffer);
}

describe("alignPcm", () => {
  it("reads whole samples from a chunk with an even number of bytes", () => {
    const { samples, carry } = alignPcm(bytesOf([1, -2, 300]), null);
    expect(Array.from(samples)).toEqual([1, -2, 300]);
    expect(carry).toBeNull();
  });

  it("carries a split sample into the next chunk instead of misreading the rest", () => {
    const all = bytesOf([1000, -1000, 32767, -32768, 5]);
    // Cut in the middle of the third sample, the way a network chunk can end.
    const first = alignPcm(all.subarray(0, 5), null);
    const second = alignPcm(all.subarray(5), first.carry);
    expect(Array.from(first.samples)).toEqual([1000, -1000]);
    expect(Array.from(second.samples)).toEqual([32767, -32768, 5]);
    expect(second.carry).toBeNull();
  });

  it("returns nothing for a single byte and keeps it for later", () => {
    const one = alignPcm(new Uint8Array([0x34]), null);
    expect(one.samples.length).toBe(0);
    expect(one.carry).toEqual(new Uint8Array([0x34]));
    const done = alignPcm(new Uint8Array([0x12]), one.carry);
    expect(Array.from(done.samples)).toEqual([0x1234]);
  });

  it("returns whole samples aligned to their own buffer, whatever offset the input had", () => {
    const backing = new Uint8Array(bytesOf([7, 8, 9]).length + 1);
    backing.set(bytesOf([7, 8, 9]), 1);
    const offset = backing.subarray(1);
    const { samples } = alignPcm(offset, null);
    expect(Array.from(samples)).toEqual([7, 8, 9]);
    expect(samples.byteOffset).toBe(0);
  });
});

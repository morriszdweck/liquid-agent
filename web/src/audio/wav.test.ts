import { describe, expect, it } from "vitest";
import { wav } from "./wav";

async function header(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer());
  const text = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    fmt: text(12, 4),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36, 4),
    dataBytes: view.getUint32(40, true),
    riffBytes: view.getUint32(4, true),
    totalBytes: view.byteLength,
    samples: new Int16Array(view.buffer.slice(44)),
  };
}

describe("wav", () => {
  it("writes a 16 kHz mono PCM16 file the speech endpoint can read", async () => {
    const blob = wav([new Int16Array([1, -2]), new Int16Array([300])], 16000);
    expect(blob.type).toBe("audio/wav");
    const h = await header(blob);
    expect(h).toMatchObject({
      riff: "RIFF",
      wave: "WAVE",
      fmt: "fmt ",
      format: 1,
      channels: 1,
      rate: 16000,
      byteRate: 32000,
      blockAlign: 2,
      bits: 16,
      data: "data",
      dataBytes: 6,
      riffBytes: 36 + 6,
      totalBytes: 44 + 6,
    });
    expect(Array.from(h.samples)).toEqual([1, -2, 300]);
  });

  it("writes a valid empty file for no audio", async () => {
    const h = await header(wav([], 16000));
    expect(h.dataBytes).toBe(0);
    expect(h.totalBytes).toBe(44);
  });
});

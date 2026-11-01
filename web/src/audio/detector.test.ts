import { describe, expect, it } from "vitest";
import { SpeechDetector, type DetectorEvents, type Frame } from "./detector";

const pcm = (n: number) => new Int16Array([n]);
const quiet = (n = 0): Frame => ({ pcm: pcm(n), rms: 0.001 });
const loud = (n = 1): Frame => ({ pcm: pcm(n), rms: 0.3 });

function recorder() {
  const log: string[] = [];
  let preroll: Int16Array[] = [];
  const events: DetectorEvents = {
    start(p) {
      preroll = p;
      log.push("start");
    },
    frame(p) {
      log.push(`frame:${p[0]}`);
    },
    end() {
      log.push("end");
    },
  };
  return { events, log, prerollValues: () => preroll.map((p) => p[0]) };
}

describe("SpeechDetector", () => {
  it("starts after a few loud frames and keeps the frames from just before", () => {
    const rec = recorder();
    const detector = new SpeechDetector(rec.events, { prerollFrames: 15, startFrames: 3, endFrames: 40, sensitivity: 1 });
    for (let i = 0; i < 4; i++) detector.push(quiet(10 + i));
    detector.push(loud(20));
    detector.push(loud(21));
    detector.push(loud(22));
    // The frame that triggers the start is part of the pre-roll, so nothing is sent twice.
    expect(rec.log).toEqual(["start"]);
    expect(rec.prerollValues()).toEqual([10, 11, 12, 13, 20, 21, 22]);
    expect(detector.speaking).toBe(true);
  });

  it("does not start on a single loud click", () => {
    const rec = recorder();
    const detector = new SpeechDetector(rec.events);
    detector.push(loud());
    detector.push(quiet());
    detector.push(loud());
    expect(rec.log).toEqual([]);
    expect(detector.speaking).toBe(false);
  });

  it("ends after a long enough pause and not on a short one", () => {
    const rec = recorder();
    const detector = new SpeechDetector(rec.events, { prerollFrames: 2, startFrames: 1, endFrames: 3, sensitivity: 1 });
    detector.push(loud(1));
    detector.push(quiet(2));
    detector.push(quiet(3));
    expect(detector.speaking).toBe(true);
    detector.push(loud(4));
    detector.push(quiet(5));
    detector.push(quiet(6));
    expect(rec.log.at(-1)).not.toBe("end");
    detector.push(quiet(7));
    expect(rec.log.at(-1)).toBe("end");
    expect(detector.speaking).toBe(false);
  });

  it("needs louder sound to hear speech while the reply is playing", () => {
    const rec = recorder();
    const detector = new SpeechDetector(rec.events, { prerollFrames: 2, startFrames: 1, endFrames: 40, sensitivity: 1 });
    // Above the normal threshold (about 0.012) but below the raised one while the reply plays (about 0.03).
    const mid: Frame = { pcm: pcm(9), rms: 0.02 };
    for (let i = 0; i < 3; i++) detector.push(mid, 2.5);
    expect(detector.speaking).toBe(false);
    for (let i = 0; i < 3; i++) detector.push(mid, 1);
    expect(detector.speaking).toBe(true);
  });
});

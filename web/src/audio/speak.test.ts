import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  speakAudio: vi.fn(),
  errorToast: vi.fn(),
  state: { settings: { voice: "male" }, speaking: null as string | null },
}));
vi.mock("../api", () => ({ speakAudio: mocks.speakAudio }));
vi.mock("../store", () => ({
  errorToast: mocks.errorToast,
  useStore: {
    getState: () => mocks.state,
    setState: (change: Partial<typeof mocks.state>) => Object.assign(mocks.state, change),
  },
}));

import { speak, stopSpeaking } from "./speak";

class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
  constructor(public url: string) { FakeAudio.instances.push(this); }
}

describe("read aloud", () => {
  beforeEach(() => {
    mocks.state.settings.voice = "male";
    mocks.state.speaking = null;
    mocks.speakAudio.mockReset().mockResolvedValue(new Blob(["audio"]));
    mocks.errorToast.mockReset();
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:clip"), revokeObjectURL: vi.fn() });
  });
  afterEach(() => { stopSpeaking(); vi.unstubAllGlobals(); });

  it("forwards the selected voice and full plain text for language detection", async () => {
    const task = speak("reply", "**Hola**, ¿cómo estás?");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(mocks.speakAudio).toHaveBeenCalledWith("Hola, ¿cómo estás?", "male", expect.any(AbortSignal), "Hola, ¿cómo estás?");
    expect(mocks.state.speaking).toBe("reply");
    FakeAudio.instances[0].onended?.();
    await task;
    expect(mocks.state.speaking).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:clip");
  });

  it("stops the previous clip without clearing the new clip's state", async () => {
    const first = speak("first", "First reply.");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    const firstSignal = mocks.speakAudio.mock.calls[0][2] as AbortSignal;
    const second = speak("second", "Second reply.");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    await first;
    expect(firstSignal.aborted).toBe(true);
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(mocks.state.speaking).toBe("second");
    FakeAudio.instances[1].onended?.();
    await second;
    expect(mocks.state.speaking).toBeNull();
    expect(mocks.errorToast).not.toHaveBeenCalled();
  });
});

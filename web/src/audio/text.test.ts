import { describe, expect, it } from "vitest";
import { chunks, plain } from "./text";

describe("plain", () => {
  it("drops Markdown syntax that would be read out loud", () => {
    expect(plain("## Title\n\n- **bold** and _soft_ `code` [a link](https://example.com)")).toBe("Title bold and soft code a link");
  });

  it("says what symbols mean and leaves code and web addresses out of the speech", () => {
    expect(plain("Save 20% & see https://example.com/a?b=1 now")).toBe("Save 20 percent and see link now");
    expect(plain("Done 🎉 ok")).toBe("Done ok");
    expect(plain("```js\nconst x = 1;\n```")).toBe("(code shown on screen)");
  });

  it("returns an empty string for only markup", () => {
    expect(plain("  ***  ")).toBe("");
  });
});

describe("chunks", () => {
  it("keeps short text in one piece", () => {
    expect(chunks("Hello there. How are you?")).toEqual(["Hello there. How are you?"]);
  });

  it("never exceeds the limit", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    for (const piece of chunks(text, 120)) expect(piece.length).toBeLessThanOrEqual(120);
  });

  it("splits a long sentence at spaces, so no word is cut in half", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    const pieces = chunks(words.join(" ") + ".", 60);
    expect(pieces.length).toBeGreaterThan(1);
    const rejoined = pieces.join(" ").split(/\s+/);
    expect(rejoined).toEqual([...words.slice(0, -1), "word79."]);
  });

  it("does not split inside a decimal number", () => {
    const pieces = chunks("The value is 3.5 degrees today. It rises later.", 30);
    expect(pieces.join(" ")).toContain("3.5");
    expect(pieces.some((p) => p.endsWith("3."))).toBe(false);
  });

  it("packs whole sentences together while they fit", () => {
    expect(chunks("One. Two. Three.", 250)).toEqual(["One. Two. Three."]);
  });

  it("only cuts a single token that is longer than a whole piece", () => {
    const token = "x".repeat(130);
    expect(chunks(`Start ${token} end.`, 50)).toEqual(["Start", "x".repeat(50), "x".repeat(50), "x".repeat(30) + " end."]);
  });

  it("returns nothing for empty text", () => {
    expect(chunks("")).toEqual([]);
    expect(chunks("   ")).toEqual([]);
  });
});

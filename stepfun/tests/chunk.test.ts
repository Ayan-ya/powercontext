import { describe, expect, it } from "vitest";
import { buildChunks, chunkText } from "../src/lib/chunk";

describe("chunkText", () => {
  it("keeps short text in one chunk", () => {
    expect(chunkText("seekdb hybrid search", { maxChars: 200, overlapChars: 20 })).toEqual([
      "seekdb hybrid search",
    ]);
  });

  it("splits on useful boundaries and preserves overlap", () => {
    const text = `${"A".repeat(90)}。${"B".repeat(90)}。${"C".repeat(90)}`;
    const chunks = chunkText(text, { maxChars: 150, overlapChars: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true);
    expect(chunks.join(" ")).toContain("A".repeat(40));
    expect(chunks.join(" ")).toContain("C".repeat(40));
  });

  it("rejects invalid overlap", () => {
    expect(() => chunkText("content", { maxChars: 100, overlapChars: 100 })).toThrow(
      "overlapChars",
    );
  });
});
describe("buildChunks", () => {
  it("attaches stable import metadata to every chunk", () => {
    const chunks = buildChunks(
      [{ source: "notes.txt", text: "A".repeat(260) }],
      { maxChars: 120, overlapChars: 20 },
      "session-test",
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.metadata.source === "notes.txt")).toBe(true);
    expect(chunks.every((chunk) => chunk.metadata.sessionId === "session-test")).toBe(true);
    expect(chunks.map((chunk) => chunk.metadata.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
  });
});

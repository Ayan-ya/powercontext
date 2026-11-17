import type { DocumentChunk } from "./types";

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

const BOUNDARIES = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "; ", "；"];

export function chunkText(
  input: string,
  { maxChars, overlapChars }: ChunkOptions,
): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 100) {
    throw new Error("maxChars must be an integer of at least 100");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("overlapChars must be an integer between 0 and maxChars - 1");
  }

  const text = input.replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").trim();
  if (!text) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      const minimumBreak = start + Math.floor(maxChars * 0.55);
      let bestBreak = -1;

      for (const boundary of BOUNDARIES) {
        const candidate = text.lastIndexOf(boundary, end);
        if (candidate >= minimumBreak) {
          bestBreak = Math.max(bestBreak, candidate + boundary.length);
        }
      }

      if (bestBreak > start) end = bestBreak;
    }

    const value = text.slice(start, end).trim();
    if (value) chunks.push(value);
    if (end >= text.length) break;

    start = Math.max(start + 1, end - overlapChars);
  }

  return chunks;
}

export function buildChunks(
  documents: Array<{ source: string; text: string }>,
  options: ChunkOptions,
  sessionId: string = crypto.randomUUID(),
): DocumentChunk[] {
  const importedAt = new Date().toISOString();

  return documents.flatMap(({ source, text }) =>
    chunkText(text, options).map((chunk, chunkIndex) => ({
      id: crypto.randomUUID(),
      text: chunk,
      metadata: {
        source,
        chunkIndex,
        charCount: chunk.length,
        importedAt,
        sessionId,
      },
    })),
  );
}

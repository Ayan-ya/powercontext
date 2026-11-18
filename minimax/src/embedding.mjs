const DIMENSIONS = 96;

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function embed(text, dimensions = DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  const normalized = String(text).normalize("NFKC").toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const features = [...words];

  for (const word of words) {
    if (word.length < 3) continue;
    for (let index = 0; index <= word.length - 3; index += 1) {
      features.push(word.slice(index, index + 3));
    }
  }

  for (const feature of features) {
    const hash = hashToken(feature);
    const slot = hash % dimensions;
    const sign = hash & 0x100 ? -1 : 1;
    vector[slot] += sign * (1 + Math.min(feature.length, 12) / 12);
  }

  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

export { DIMENSIONS };

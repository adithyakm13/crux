/**
 * MinHash sketch and LSH banding (§6).
 *
 * Over **character 5-grams**, not word shingles. A 15-word assertion message
 * yields roughly 13 word-trigrams, and a Jaccard estimate from 13 shingles is
 * noise. The same message yields on the order of 80 character 5-grams.
 *
 * Below `MIN_SKETCH_CHARS` normalized characters the sketch is not reliable at
 * any shingle size, so callers fall back to normalized Levenshtein distance —
 * cheap on short strings, and honest about what it is.
 *
 * Everything here is integer arithmetic with fixed seeds so the signature is
 * identical on every machine and platform. That is a gate (§6), not a
 * nicety.
 */

export const SHINGLE_SIZE = 5;
export const PERMUTATIONS = 128;
/** Below this length the sketch is skipped; see the module comment. */
export const MIN_SKETCH_CHARS = 40;

/**
 * Banding for the LSH index: 32 bands of 4 rows.
 *
 * The probability a pair with Jaccard s becomes a candidate is
 * `1 - (1 - s^r)^b`. With b=32, r=4 that is 0.12 at s=0.2, 0.87 at s=0.4 and
 * 0.998 at s=0.6 — aggressive enough that genuinely similar messages are not
 * missed, and the false candidates are discarded by exact scoring immediately
 * afterwards.
 */
export const BANDS = 32;
export const ROWS_PER_BAND = 4;

const MERSENNE_31 = 2147483647; // 2^31 - 1, prime

/** Deterministic permutation coefficients, generated once from a fixed seed. */
const COEFFICIENTS = (() => {
  // A fixed LCG rather than Math.random: the signature must not depend on when
  // or where the process started.
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const a = new Int32Array(PERMUTATIONS);
  const b = new Int32Array(PERMUTATIONS);
  for (let i = 0; i < PERMUTATIONS; i++) {
    // `a` must be non-zero mod p for the map to be a permutation.
    a[i] = (next() % (MERSENNE_31 - 1)) + 1;
    b[i] = next() % MERSENNE_31;
  }
  return { a, b };
})();

/**
 * (a * b) mod (2^31-1) without leaving the safe-integer range.
 *
 * The direct product overflows: a and b are both under 2^31, so a*b reaches
 * 2^62 while doubles are exact only to 2^53. Splitting `a` into 15- and
 * 16-bit halves keeps every intermediate under 2^48.
 */
function mulmod(a: number, b: number): number {
  const hi = Math.floor(a / 65536);
  const lo = a % 65536;
  return ((((hi * b) % MERSENNE_31) * 65536) % MERSENNE_31 + lo * b) % MERSENNE_31;
}

/** FNV-1a, 32-bit. Fast, deterministic, and adequate as the base hash. */
function hashShingle(s: string, start: number, end: number): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    // Characters outside Latin-1 carry information in the high byte too.
    const hi = s.charCodeAt(i) >>> 8;
    if (hi !== 0) {
      h ^= hi;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0) % MERSENNE_31;
}

/**
 * Compute the MinHash signature of `text`, or null when the text is too short
 * for the sketch to mean anything.
 */
export function minhash(text: string): Int32Array | null {
  if (text.length < MIN_SKETCH_CHARS) return null;
  const seen = new Set<number>();
  for (let i = 0; i + SHINGLE_SIZE <= text.length; i++) {
    seen.add(hashShingle(text, i, i + SHINGLE_SIZE));
  }
  if (seen.size === 0) return null;

  const sig = new Int32Array(PERMUTATIONS).fill(MERSENNE_31);
  for (const h of seen) {
    for (let i = 0; i < PERMUTATIONS; i++) {
      // (a*h + b) mod p, computed without overflowing a double's integer range.
      const v = (mulmod(COEFFICIENTS.a[i]!, h) + COEFFICIENTS.b[i]!) % MERSENNE_31;
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity: the fraction of positions that agree. */
export function estimateJaccard(a: Int32Array, b: Int32Array): number {
  if (a.length !== b.length) {
    throw new Error(`estimateJaccard: signature lengths differ (${a.length} vs ${b.length})`);
  }
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/** Band keys for the LSH index. Two items sharing any key are candidates. */
export function bandKeys(sig: Int32Array): string[] {
  const keys: string[] = [];
  for (let band = 0; band < BANDS; band++) {
    let h = 0x811c9dc5 ^ band;
    for (let r = 0; r < ROWS_PER_BAND; r++) {
      const v = sig[band * ROWS_PER_BAND + r]!;
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 24) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    keys.push(`${band}:${(h >>> 0).toString(36)}`);
  }
  return keys;
}

/**
 * Normalized Levenshtein similarity in [0,1], for messages too short to sketch.
 *
 * Two rolling rows rather than a full matrix, and a hard length cap: this is
 * only ever called on strings under `MIN_SKETCH_CHARS`, but the cap means a
 * caller that misuses it degrades instead of hanging.
 */
export function levenshteinSimilarity(a: string, b: string, maxLen = 512): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const s = a.length <= maxLen ? a : a.slice(0, maxLen);
  const t = b.length <= maxLen ? b : b.slice(0, maxLen);
  let prev = new Uint32Array(t.length + 1);
  let curr = new Uint32Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const distance = prev[t.length]!;
  return 1 - distance / Math.max(s.length, t.length);
}

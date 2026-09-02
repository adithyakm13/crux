/**
 * Gate evaluation machinery (§2, "How every gate in this document is evaluated").
 *
 * Rules this module exists to enforce:
 *  - No point estimate is gate evidence. Everything returns an interval.
 *  - Bootstrap resamples RUNS, never pairs. Pairs inside a run are strongly
 *    correlated; treating them as independent produces intervals several times
 *    too narrow, which is how a failing gate gets reported as passing.
 *  - A gate passes on the LOWER bound, never the point estimate.
 */

export interface Interval {
  point: number;
  lower: number;
  upper: number;
  /** Nominal coverage, e.g. 0.95. */
  level: number;
  method: 'wilson' | 'bootstrap-percentile';
  /** Sample size the interval was computed from. For bootstrap: number of runs. */
  n: number;
}

// ---------------------------------------------------------------------------
// Proportions
// ---------------------------------------------------------------------------

/** Two-sided standard normal quantile for the given confidence level. */
function zFor(level: number): number {
  // Acklam's inverse-normal approximation; |error| < 1.15e-9 over the domain.
  const p = 1 - (1 - level) / 2;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * Wilson score interval. Used for every proportion crux reports — separability,
 * per-category precision, fingerprint stability, rename recall, selection recall.
 *
 * Wilson rather than normal-approximation because crux routinely reports on
 * small samples (a category with 30 examples) where the normal interval is
 * badly wrong and can extend past 0 or 1.
 */
export function wilson(successes: number, n: number, level = 0.95): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(n)) {
    throw new Error(`wilson: successes and n must be integers (got ${successes}, ${n})`);
  }
  if (n < 0 || successes < 0 || successes > n) {
    throw new Error(`wilson: require 0 <= successes <= n (got ${successes}, ${n})`);
  }
  if (n === 0) return { point: NaN, lower: 0, upper: 1, level, method: 'wilson', n: 0 };
  const z = zFor(level);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    point: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    level,
    method: 'wilson',
    n,
  };
}

/** A gate passes only when the lower bound clears the threshold. */
export function gatePasses(interval: Interval, threshold: number): boolean {
  return Number.isFinite(interval.lower) && interval.lower >= threshold;
}

// ---------------------------------------------------------------------------
// Deterministic RNG. Bootstrap results must reproduce exactly across machines.
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, adequate for resampling; seeded for reproducibility. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Pairwise clustering metrics (§8)
// ---------------------------------------------------------------------------

/** Pair-decision counts for one run. Aggregation across runs sums these. */
export interface PairCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

export const EMPTY_PAIR_COUNTS: PairCounts = {
  truePositives: 0,
  falsePositives: 0,
  falseNegatives: 0,
  trueNegatives: 0,
};

/**
 * Count pair decisions for a single run.
 *
 * `predicted[i]` and `truth[i]` are group labels (any comparable string) for
 * the same failure. A pair is "same cause" when the two labels are equal.
 * Singletons are groups of one, so a correctly-isolated singleton contributes
 * true negatives — never forced membership to make output tidy (§8).
 */
export function pairCounts(predicted: readonly string[], truth: readonly string[]): PairCounts {
  if (predicted.length !== truth.length) {
    throw new Error(
      `pairCounts: predicted (${predicted.length}) and truth (${truth.length}) differ in length`,
    );
  }
  const c = { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 };
  for (let i = 0; i < predicted.length; i++) {
    for (let j = i + 1; j < predicted.length; j++) {
      const same = predicted[i] === predicted[j];
      const shouldBeSame = truth[i] === truth[j];
      if (same && shouldBeSame) c.truePositives++;
      else if (same && !shouldBeSame) c.falsePositives++;
      else if (!same && shouldBeSame) c.falseNegatives++;
      else c.trueNegatives++;
    }
  }
  return c;
}

export interface PrfScore {
  precision: number;
  recall: number;
  f1: number;
  pairs: number;
}

export function prf(c: PairCounts): PrfScore {
  const pDen = c.truePositives + c.falsePositives;
  const rDen = c.truePositives + c.falseNegatives;
  const precision = pDen === 0 ? NaN : c.truePositives / pDen;
  const recall = rDen === 0 ? NaN : c.truePositives / rDen;
  // F1 = 2TP / (2TP + FP + FN). When TP is zero but FP or FN is not, that is
  // zero — a real, measured, maximally bad score — not an undefined quantity.
  // Reporting NaN there prints "n/a", which reads as "could not be measured"
  // and hides the one baseline outcome that must not be missed: the payload
  // does not carry the signal. NaN is reserved for the genuinely undefined
  // case where there are no positive pairs on either side to score.
  const f1 =
    pDen === 0 && rDen === 0
      ? NaN
      : (2 * c.truePositives) / (2 * c.truePositives + c.falsePositives + c.falseNegatives);
  return {
    precision,
    recall,
    f1,
    pairs: c.truePositives + c.falsePositives + c.falseNegatives + c.trueNegatives,
  };
}

export function sumPairCounts(all: readonly PairCounts[]): PairCounts {
  return all.reduce(
    (a, b) => ({
      truePositives: a.truePositives + b.truePositives,
      falsePositives: a.falsePositives + b.falsePositives,
      falseNegatives: a.falseNegatives + b.falseNegatives,
      trueNegatives: a.trueNegatives + b.trueNegatives,
    }),
    EMPTY_PAIR_COUNTS,
  );
}

/**
 * Bootstrap over runs. `perRun` is one entry per run; resampling draws runs
 * with replacement, sums their pair counts, and recomputes the aggregate.
 *
 * Resampling runs rather than pairs is the whole point: it is the unit of
 * independence. Runs are what vary between customers, weeks, and codebases.
 */
export function bootstrapPairF1(
  perRun: readonly PairCounts[],
  opts: { resamples?: number; level?: number; seed?: number } = {},
): Interval {
  const resamples = opts.resamples ?? 2000;
  const level = opts.level ?? 0.95;
  const rng = makeRng(opts.seed ?? 0x0c0ffee);
  const n = perRun.length;
  if (n === 0) {
    return { point: NaN, lower: NaN, upper: NaN, level, method: 'bootstrap-percentile', n: 0 };
  }
  const point = prf(sumPairCounts(perRun)).f1;
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const acc = { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 };
    for (let i = 0; i < n; i++) {
      const c = perRun[Math.floor(rng() * n)]!;
      acc.truePositives += c.truePositives;
      acc.falsePositives += c.falsePositives;
      acc.falseNegatives += c.falseNegatives;
      acc.trueNegatives += c.trueNegatives;
    }
    const f = prf(acc).f1;
    if (Number.isFinite(f)) draws.push(f);
  }
  if (draws.length === 0) {
    return { point, lower: NaN, upper: NaN, level, method: 'bootstrap-percentile', n };
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    point,
    lower: quantileSorted(draws, alpha),
    upper: quantileSorted(draws, 1 - alpha),
    level,
    method: 'bootstrap-percentile',
    n,
  };
}

function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

// ---------------------------------------------------------------------------
// Inter-labeler agreement (§2)
// ---------------------------------------------------------------------------

export interface KappaResult {
  kappa: number;
  observedAgreement: number;
  expectedAgreement: number;
  n: number;
  /** Per-category counts, for spotting a single category dragging kappa down. */
  perCategory: Record<string, { a: number; b: number; agreed: number }>;
}

/**
 * Cohen's kappa on categorical labels from two independent labelers.
 *
 * Human agreement is the ceiling. A model scoring above it is overfitting the
 * labeler, not solving the problem.
 */
export function cohensKappa(a: readonly string[], b: readonly string[]): KappaResult {
  if (a.length !== b.length) {
    throw new Error(`cohensKappa: label arrays differ in length (${a.length} vs ${b.length})`);
  }
  const n = a.length;
  const perCategory: Record<string, { a: number; b: number; agreed: number }> = {};
  const bump = (k: string) => (perCategory[k] ??= { a: 0, b: 0, agreed: 0 });
  let agreed = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    bump(ai).a++;
    bump(bi).b++;
    if (ai === bi) {
      agreed++;
      bump(ai).agreed++;
    }
  }
  if (n === 0) {
    return { kappa: NaN, observedAgreement: NaN, expectedAgreement: NaN, n: 0, perCategory };
  }
  const po = agreed / n;
  let pe = 0;
  for (const k of Object.keys(perCategory)) {
    pe += (perCategory[k]!.a / n) * (perCategory[k]!.b / n);
  }
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, observedAgreement: po, expectedAgreement: pe, n, perCategory };
}

/**
 * Bootstrap a proportion whose trials are grouped into correlated clusters.
 *
 * Same contract as bootstrapPairF1 and for the same reason: resample the
 * independent unit (the run), not the individual trials. Handing a pooled
 * numerator and denominator to `wilson` asserts that every trial is an
 * independent Bernoulli draw, which for pairs inside a run is false — they
 * share the labelers, the build and the root causes.
 */
export function bootstrapProportion(
  perRun: readonly { successes: number; total: number }[],
  opts: { resamples?: number; level?: number; seed?: number } = {},
): Interval {
  const resamples = opts.resamples ?? 2000;
  const level = opts.level ?? 0.95;
  const rng = makeRng(opts.seed ?? 0x0c0ffee);
  const usable = perRun.filter((r) => r.total > 0);
  const n = usable.length;
  const pooledSuccesses = usable.reduce((a, r) => a + r.successes, 0);
  const pooledTotal = usable.reduce((a, r) => a + r.total, 0);
  if (n === 0 || pooledTotal === 0) {
    return { point: NaN, lower: NaN, upper: NaN, level, method: 'bootstrap-percentile', n: 0 };
  }
  const point = pooledSuccesses / pooledTotal;
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    let t = 0;
    for (let i = 0; i < n; i++) {
      const r = usable[Math.floor(rng() * n)]!;
      s += r.successes;
      t += r.total;
    }
    if (t > 0) draws.push(s / t);
  }
  if (draws.length === 0) {
    return { point, lower: NaN, upper: NaN, level, method: 'bootstrap-percentile', n };
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    point,
    lower: quantileSorted(draws, alpha),
    upper: quantileSorted(draws, 1 - alpha),
    level,
    method: 'bootstrap-percentile',
    n,
  };
}

/**
 * Pairwise grouping agreement between two labelers: the fraction of failure
 * pairs on which they agree about "same root cause".
 *
 * `agreement` is a bootstrap over runs, because that is the unit of
 * independence. An earlier version pooled every pair into a single Wilson
 * interval, which is precisely the error this module's header forbids: on a
 * corpus of ten runs where two are wholly ambiguous and eight are clean, the
 * pooled interval was roughly four times too narrow and cleared the 0.80
 * ambiguity gate that the correct interval fails.
 *
 * `pooledPointEstimate` is kept as a diagnostic only. It is never a gate
 * input — it carries no interval, precisely so it cannot be mistaken for one.
 */
export function pairwiseAgreement(
  perRun: readonly { a: readonly string[]; b: readonly string[] }[],
  opts: { resamples?: number; level?: number; seed?: number } = {},
): { agreement: Interval; pairs: number; runs: number; pooledPointEstimate: number } {
  const buckets: { successes: number; total: number }[] = [];
  let agreed = 0;
  let total = 0;
  for (const run of perRun) {
    const c = pairCounts(run.a, run.b);
    const runAgreed = c.truePositives + c.trueNegatives;
    const runTotal =
      c.truePositives + c.falsePositives + c.falseNegatives + c.trueNegatives;
    buckets.push({ successes: runAgreed, total: runTotal });
    agreed += runAgreed;
    total += runTotal;
  }
  return {
    agreement: bootstrapProportion(buckets, opts),
    pairs: total,
    runs: buckets.filter((b) => b.total > 0).length,
    pooledPointEstimate: total === 0 ? NaN : agreed / total,
  };
}

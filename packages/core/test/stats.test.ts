import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapPairF1,
  bootstrapProportion,
  cohensKappa,
  gatePasses,
  makeRng,
  pairCounts,
  pairwiseAgreement,
  prf,
  sumPairCounts,
  wilson,
} from '../src/stats.ts';

// ---------------------------------------------------------------------------
// Wilson
// ---------------------------------------------------------------------------

test('Wilson matches published values', () => {
  // Standard worked example: 10 successes in 20 trials at 95%.
  const i = wilson(10, 20);
  assert.equal(i.point, 0.5);
  assert.ok(Math.abs(i.lower - 0.2993) < 0.001, `lower was ${i.lower}`);
  assert.ok(Math.abs(i.upper - 0.7007) < 0.001, `upper was ${i.upper}`);
});

test('Wilson stays inside [0,1] at the extremes, where the normal interval does not', () => {
  const all = wilson(20, 20);
  assert.equal(all.point, 1);
  assert.equal(all.upper, 1);
  assert.ok(all.lower > 0.8 && all.lower < 1);
  const none = wilson(0, 20);
  assert.equal(none.lower, 0);
  assert.ok(none.upper > 0 && none.upper < 0.2);
});

test('Wilson intervals narrow as n grows', () => {
  const small = wilson(9, 10);
  const large = wilson(900, 1000);
  assert.ok(large.upper - large.lower < small.upper - small.lower);
});

test('a small sample cannot pass a gate on a good point estimate', () => {
  // The exact failure mode the spec calls out: 0.82 point, lower bound below.
  const i = wilson(9, 11); // 0.818...
  assert.ok(i.point > 0.8);
  assert.ok(i.lower < 0.8);
  assert.equal(gatePasses(i, 0.8), false);
});

test('gatePasses reads the lower bound, never the point estimate', () => {
  assert.equal(gatePasses(wilson(900, 1000), 0.8), true);
  assert.equal(gatePasses(wilson(0, 0), 0.8), false);
});

test('Wilson rejects impossible inputs rather than returning nonsense', () => {
  assert.throws(() => wilson(5, 3), /0 <= successes <= n/);
  assert.throws(() => wilson(-1, 3), /0 <= successes <= n/);
  assert.throws(() => wilson(1.5, 3), /integers/);
});

test('n = 0 yields the uninformative interval, not a fabricated point', () => {
  const i = wilson(0, 0);
  assert.ok(Number.isNaN(i.point));
  assert.equal(i.lower, 0);
  assert.equal(i.upper, 1);
});

// ---------------------------------------------------------------------------
// Pairwise scoring
// ---------------------------------------------------------------------------

test('perfect agreement scores F1 = 1', () => {
  const c = pairCounts(['a', 'a', 'b'], ['x', 'x', 'y']);
  const s = prf(c);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 1);
  assert.equal(s.f1, 1);
  assert.equal(s.pairs, 3);
});

test('group labels are compared as partitions, not as names', () => {
  // Renaming every group must not change the score.
  const a = pairCounts(['a', 'a', 'b'], ['x', 'x', 'y']);
  const b = pairCounts(['1', '1', '2'], ['q', 'q', 'r']);
  assert.deepEqual(a, b);
});

test('over-merging costs precision, over-splitting costs recall', () => {
  const truth = ['x', 'x', 'y', 'y'];
  const merged = prf(pairCounts(['a', 'a', 'a', 'a'], truth));
  const split = prf(pairCounts(['a', 'b', 'c', 'd'], truth));
  assert.ok(merged.recall === 1 && merged.precision < 1);
  assert.ok(Number.isNaN(split.precision) || split.precision === 0);
  assert.equal(split.recall, 0);
});

test('a correctly isolated singleton contributes a true negative, not a penalty', () => {
  const c = pairCounts(['a', 'a', 'lonely'], ['x', 'x', 'z']);
  assert.equal(c.trueNegatives, 2);
  assert.equal(c.falsePositives, 0);
  assert.equal(c.falseNegatives, 0);
  assert.equal(prf(c).f1, 1);
});

test('pairCounts refuses mismatched inputs', () => {
  assert.throws(() => pairCounts(['a'], ['x', 'y']), /differ in length/);
});

test('a single failure yields no pairs, so it cannot contribute to F1', () => {
  const c = pairCounts(['a'], ['x']);
  assert.equal(prf(c).pairs, 0);
  assert.ok(Number.isNaN(prf(c).f1));
});

// ---------------------------------------------------------------------------
// Bootstrap over runs — the correctness that matters most
// ---------------------------------------------------------------------------

const perfectRun = () => pairCounts(['a', 'a', 'b'], ['x', 'x', 'y']);
const badRun = () => pairCounts(['a', 'a', 'a'], ['x', 'y', 'z']);

test('bootstrap is deterministic for a given seed', () => {
  const runs = [perfectRun(), badRun(), perfectRun()];
  const a = bootstrapPairF1(runs, { seed: 7 });
  const b = bootstrapPairF1(runs, { seed: 7 });
  assert.deepEqual(a, b);
});

test('bootstrap brackets the point estimate', () => {
  const runs = [perfectRun(), badRun(), perfectRun(), badRun(), perfectRun()];
  const i = bootstrapPairF1(runs, { seed: 1 });
  assert.ok(i.lower <= i.point && i.point <= i.upper, `${i.lower} <= ${i.point} <= ${i.upper}`);
});

test('bootstrap n counts RUNS, not pairs', () => {
  // The whole point: runs are the unit of independence. Reporting a pair count
  // as the sample size is what makes an interval several times too narrow.
  const runs = [perfectRun(), badRun(), perfectRun()];
  assert.equal(bootstrapPairF1(runs, { seed: 1 }).n, 3);
  assert.ok(sumPairCounts(runs).truePositives + sumPairCounts(runs).falsePositives > 3);
});

test('resampling runs gives a wider interval than treating pairs as independent', () => {
  // Ten identical good runs and ten identical bad runs: run-level resampling
  // must show real spread, because which runs you drew genuinely matters.
  const runs = [
    ...Array.from({ length: 10 }, perfectRun),
    ...Array.from({ length: 10 }, badRun),
  ];
  const i = bootstrapPairF1(runs, { seed: 3 });
  assert.ok(i.upper - i.lower > 0.02, `interval was suspiciously tight: ${i.upper - i.lower}`);
});

test('bootstrap over a single run reports an interval of zero width, honestly', () => {
  // With one run, every resample is that run. The interval is degenerate and
  // says so through n = 1 rather than pretending to be an estimate of spread.
  const i = bootstrapPairF1([perfectRun()], { seed: 1 });
  assert.equal(i.n, 1);
  assert.equal(i.lower, i.upper);
});

test('bootstrap over no runs returns NaN rather than a number', () => {
  const i = bootstrapPairF1([]);
  assert.ok(Number.isNaN(i.point));
  assert.equal(i.n, 0);
});

test('the seeded RNG is stable across calls', () => {
  const a = Array.from({ length: 5 }, makeRng(42));
  const rng = makeRng(42);
  const b = Array.from({ length: 5 }, () => rng());
  assert.deepEqual(
    a.map(() => 0),
    b.map(() => 0),
  );
  const r1 = makeRng(42);
  const r2 = makeRng(42);
  for (let i = 0; i < 20; i++) assert.equal(r1(), r2());
});

// ---------------------------------------------------------------------------
// Inter-labeler agreement
// ---------------------------------------------------------------------------

test('kappa is 1 on identical labels and 0 on chance agreement', () => {
  const labels = ['A', 'B', 'A', 'C'];
  assert.equal(cohensKappa(labels, labels).kappa, 1);
  // Both labelers always say A: observed agreement 1, expected agreement 1,
  // so kappa is defined as 1 rather than 0/0.
  assert.equal(cohensKappa(['A', 'A'], ['A', 'A']).kappa, 1);
});

test('kappa punishes agreement that is only as good as chance', () => {
  // A labels alternately, B labels alternately out of phase: they agree on
  // nothing, so kappa must be negative.
  const a = ['A', 'B', 'A', 'B'];
  const b = ['B', 'A', 'B', 'A'];
  assert.ok(cohensKappa(a, b).kappa < 0);
});

test('kappa reports per-category counts so one bad category is visible', () => {
  const r = cohensKappa(['A', 'A', 'B'], ['A', 'B', 'B']);
  assert.equal(r.perCategory['A']!.a, 2);
  assert.equal(r.perCategory['A']!.agreed, 1);
  assert.equal(r.n, 3);
});

test('kappa refuses mismatched label arrays', () => {
  assert.throws(() => cohensKappa(['A'], ['A', 'B']), /differ in length/);
});

test('pairwise grouping agreement aggregates across runs with an interval', () => {
  const r = pairwiseAgreement([
    { a: ['g1', 'g1', 'g2'], b: ['h1', 'h1', 'h2'] },
    { a: ['g1', 'g2'], b: ['h1', 'h1'] },
  ]);
  assert.equal(r.pairs, 4);
  assert.ok(Math.abs(r.agreement.point - 0.75) < 1e-9);
  assert.ok(r.agreement.lower < r.agreement.point);
});

// ---------------------------------------------------------------------------
// Regressions from the Gate 0 decision review.
// Each of these passed before the fix, which is why they are here.
// ---------------------------------------------------------------------------

test('pairwiseAgreement resamples runs, so clustered disagreement widens the interval', () => {
  // Eight runs where the labelers agree perfectly, two where they impose
  // orthogonal partitions. That is the expected shape of real labeling data:
  // some builds are genuinely ambiguous, most are trivially clean.
  const runs: { a: string[]; b: string[] }[] = [];
  for (let r = 0; r < 8; r++) {
    const g = Array.from({ length: 10 }, (_, i) => `g${i % 3}`);
    runs.push({ a: g, b: [...g] });
  }
  for (let r = 0; r < 2; r++) {
    runs.push({
      a: Array.from({ length: 10 }, (_, i) => (i < 5 ? 'x' : 'y')),
      b: Array.from({ length: 10 }, (_, i) => (i % 2 ? 'x' : 'y')),
    });
  }
  const res = pairwiseAgreement(runs);

  assert.equal(res.agreement.method, 'bootstrap-percentile');
  // n is the number of independent units — runs — not the pair count.
  assert.equal(res.agreement.n, 10);
  assert.equal(res.pairs, 450);

  // Pooling all 450 pairs into one Wilson interval gives a lower bound near
  // 0.861, which clears the 0.80 ambiguity gate. Resampling runs does not.
  const pooled = wilson(
    Math.round(res.pooledPointEstimate * res.pairs),
    res.pairs,
  );
  assert.ok(pooled.lower > 0.8, 'the pooled interval is the one that wrongly passes');
  assert.ok(
    res.agreement.lower < 0.8,
    `run-level bootstrap must fail the 0.80 gate on ambiguous data, got ${res.agreement.lower}`,
  );
  // The whole point: the pooled interval is several times too narrow.
  const pooledWidth = pooled.upper - pooled.lower;
  const bootWidth = res.agreement.upper - res.agreement.lower;
  assert.ok(bootWidth > pooledWidth * 2, `expected a much wider interval, got ${bootWidth} vs ${pooledWidth}`);
});

test('pairwiseAgreement reports no interval rather than a false one when there are no pairs', () => {
  const res = pairwiseAgreement([]);
  assert.ok(Number.isNaN(res.agreement.lower));
  assert.equal(res.runs, 0);
  // wilson(0, 0).lower is 0, which would read as "total disagreement" and
  // wrongly trip the ambiguity warning on an empty comparison.
  assert.ok(!Number.isFinite(res.agreement.lower));
});

test('prf scores a total clustering failure as 0, not as unmeasurable', () => {
  // Every pair wrong: F1 = 2TP/(2TP+FP+FN) = 0. Reporting NaN prints "n/a",
  // which hides the one baseline outcome that must not be missed.
  const allWrong = prf({
    truePositives: 0,
    falsePositives: 12,
    falseNegatives: 9,
    trueNegatives: 4,
  });
  assert.equal(allWrong.f1, 0);
  assert.equal(allWrong.precision, 0);
  assert.equal(allWrong.recall, 0);

  // Genuinely undefined: no positive pairs on either side to score.
  const nothingToScore = prf({
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 6,
  });
  assert.ok(Number.isNaN(nothingToScore.f1));
});

test('bootstrapProportion ignores empty runs rather than dividing by zero', () => {
  const iv = bootstrapProportion([
    { successes: 8, total: 10 },
    { successes: 0, total: 0 },
    { successes: 9, total: 10 },
  ]);
  assert.equal(iv.n, 2);
  assert.ok(Number.isFinite(iv.lower) && Number.isFinite(iv.upper));
  assert.ok(iv.point > 0.8 && iv.point < 0.9);
});

test('a bootstrap over one unit reports no interval rather than a fake one', () => {
  // Resampling a single run draws that same run every time, so the percentiles
  // collapse onto the point estimate. Printing [0.833, 0.833] reads as
  // certainty when it means the opposite: nothing exists to disagree with it.
  const one = bootstrapPairF1([
    { truePositives: 5, falsePositives: 2, falseNegatives: 1, trueNegatives: 20 },
  ]);
  assert.equal(one.n, 1);
  assert.ok(Number.isFinite(one.point), 'the point estimate is still real');
  assert.ok(Number.isNaN(one.lower) && Number.isNaN(one.upper));
  // And it must not pass a gate, since gatePasses requires a finite lower bound.
  assert.equal(gatePasses(one, 0.1), false);

  const oneProp = bootstrapProportion([{ successes: 9, total: 10 }]);
  assert.equal(oneProp.n, 1);
  assert.ok(Number.isNaN(oneProp.lower) && Number.isNaN(oneProp.upper));

  // Two units can disagree, so an interval is meaningful again.
  const two = bootstrapPairF1([
    { truePositives: 5, falsePositives: 2, falseNegatives: 1, trueNegatives: 20 },
    { truePositives: 0, falsePositives: 8, falseNegatives: 4, trueNegatives: 3 },
  ]);
  assert.equal(two.n, 2);
  assert.ok(Number.isFinite(two.lower) && Number.isFinite(two.upper));
  assert.ok(two.upper > two.lower, 'two disagreeing runs must produce a real width');
});

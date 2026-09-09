import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleForLabelling } from '../src/sample.ts';
import { newCorpusRun, type CorpusRun } from '../src/schema.ts';

let seq = 0;

/**
 * A run of `n` failures whose stack shape makes `detectFramework` return the
 * requested framework. The markers are the real ones the detector keys on, so
 * the fixture cannot drift from what the detector actually does.
 */
function runOf(repo: string, n: number, framework: 'pytest' | 'junit-jvm' | 'jest'): CorpusRun {
  const run = newCorpusRun({
    fidelity: 'artifact',
    source: {
      provider: 'github-actions',
      repo,
      providerRunId: String(++seq),
      attempt: 1,
      licenseSpdx: 'MIT',
      licenseRaw: 'MIT',
      url: `https://example.invalid/${seq}`,
      harvestedAt: '2026-01-01T00:00:00.000Z',
    } as never,
  });
  const stack: Record<string, string> = {
    pytest: '  File "tests/test_a.py", line 5, in test_x\n    assert 1 == 2',
    'junit-jvm': '\tat com.acme.Thing.check(Thing.java:42)\n\tat org.junit.runners.ParentRunner.run(ParentRunner.java:1)',
    jest: '    at Object.<anonymous> (src/a.test.js:1:1)\n    at jestAdapter (node_modules/jest-circus/build/legacy-code-todo-rewrite/jestAdapter.js:1:1)',
  };
  run.failures = Array.from({ length: n }, (_, i) => ({
    failureId: `f${i}`,
    sourceFile: framework === 'pytest' ? 'pytest.xml' : 'results.xml',
    producerAdapter: 'junit',
    shardIndex: 0,
    attemptIndex: 0,
    displayName: `test ${i}`,
    suitePath: ['suite'],
    filePath: null,
    status: 'failed',
    durationMs: 1,
    errorType: 'AssertionError',
    message: `failure ${i}`,
    stackText: stack[framework]!,
    stdout: null,
    stderr: null,
  })) as never;
  run.counts = { ...run.counts, attempts: n, failures: n, filesParsed: 1 };
  return run;
}

test('suite collapses and single-failure runs are excluded', () => {
  const runs = [
    runOf('a/one', 600, 'pytest'), // collapse
    runOf('a/two', 1, 'pytest'), // too small to carry pairs
    runOf('a/three', 10, 'pytest'),
  ];
  const r = sampleForLabelling(runs, { targetFailures: 100 });
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0]!.failures, 10);
  assert.equal(r.excluded.tooLarge, 1);
  assert.equal(r.excluded.tooSmall, 1);
});

test('no single repository can dominate the sample', () => {
  // Ten eligible runs, all from one repo. Without the cap the sample would be
  // ten runs of one project and would measure that project.
  const runs = Array.from({ length: 10 }, () => runOf('hog/monorepo', 12, 'pytest'));
  const r = sampleForLabelling(runs, { targetFailures: 100, maxRunsPerRepo: 3 });
  assert.equal(r.runs.length, 3);
  assert.equal(Object.keys(r.byRepo).length, 1);
  assert.ok(r.excluded.repoCapped > 0);
});

test('frameworks are filled round-robin rather than by corpus share', () => {
  const runs = [
    ...Array.from({ length: 8 }, (_, i) => runOf(`py/p${i}`, 10, 'pytest')),
    runOf('jvm/j0', 10, 'junit-jvm'),
  ];
  const r = sampleForLabelling(runs, { targetFailures: 40 });
  // The single JVM run must be picked despite pytest being 8x more available.
  assert.ok(r.byFramework['junit-jvm'] !== undefined, 'the rare framework was dropped');
});

test('a framework absent from the sample is reported as a gap, at failure level', () => {
  // The regression this locks: gaps were computed from each run's DOMINANT
  // framework. jest failures that live inside runs dominated by something else
  // are a large share of the corpus while dominating no run, so the run-level
  // check reported no gap even though the sample contained none of them.
  const mixed = runOf('mix/app', 30, 'pytest');
  const jestRun = runOf('mix/app2', 300, 'jest'); // collapse: excluded from sample
  const r = sampleForLabelling([mixed, jestRun], { targetFailures: 30 });

  assert.ok(
    r.corpusMix['jest']! > 0.02,
    'fixture should make jest a material share of the corpus',
  );
  assert.equal(r.sampleMix['jest'] ?? 0, 0);
  assert.ok(
    r.gaps.some((g) => g.framework === 'jest'),
    `jest should be reported as a gap, got ${JSON.stringify(r.gaps)}`,
  );
});

test('a negligible framework is not reported as a gap', () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => runOf(`py/p${i}`, 20, 'pytest')),
    runOf('tiny/t', 1, 'jest'), // under 2% of failures
  ];
  const r = sampleForLabelling(runs, { targetFailures: 60 });
  assert.ok(!r.gaps.some((g) => g.framework === 'jest'), 'noise should not be reported as a gap');
});

test('the same seed selects the same runs', () => {
  const runs = Array.from({ length: 12 }, (_, i) => runOf(`r/${i % 5}`, 8 + (i % 5), 'pytest'));
  const a = sampleForLabelling(runs, { seed: 42 });
  const b = sampleForLabelling(runs, { seed: 42 });
  const c = sampleForLabelling(runs, { seed: 43 });
  assert.deepEqual(
    a.runs.map((x) => x.corpusRunId),
    b.runs.map((x) => x.corpusRunId),
  );
  assert.equal(a.digest, b.digest);
  // Different seed should generally differ; if it does not, the shuffle is not
  // doing anything and the sample is just directory order.
  assert.ok(a.digest !== c.digest || runs.length < 3);
});

test('pairs are counted, because pairs are what a clustering score is made of', () => {
  const r = sampleForLabelling([runOf('a/b', 10, 'pytest')], { targetFailures: 10 });
  assert.equal(r.totalFailures, 10);
  assert.equal(r.totalPairs, 45); // 10 * 9 / 2
});

test('an empty corpus yields an empty sample rather than throwing', () => {
  const r = sampleForLabelling([]);
  assert.equal(r.runs.length, 0);
  assert.equal(r.totalFailures, 0);
  assert.equal(r.totalPairs, 0);
  assert.deepEqual(r.gaps, []);
});

// ---------------------------------------------------------------------------
// Coverage-first selection and within-run slicing.
//
// Each of these locks a regression hit while building the policy: stratifying
// by a run's dominant framework could not reach a framework that never
// dominates; proportional matching starved small families; and the fallback
// branch bypassed the slice cap.
// ---------------------------------------------------------------------------

test('slicing reaches a framework that exists only inside suite collapses', () => {
  // jest here dominates no eligible run — it lives in a 300-failure collapse,
  // exactly as in the real corpus.
  const runs = [
    runOf('a/small', 20, 'pytest'),
    runOf('b/collapse', 300, 'jest'),
  ];

  const without = sampleForLabelling(runs, { targetFailures: 60 });
  assert.equal(without.sampleMix['jest'] ?? 0, 0, 'without slicing jest is unreachable');
  assert.ok(without.gaps.some((g) => g.framework === 'jest'));

  const withSlice = sampleForLabelling(runs, { targetFailures: 60, sliceLargeRuns: 20 });
  assert.ok((withSlice.sampleMix['jest'] ?? 0) > 0, 'slicing must make jest reachable');
  assert.equal(withSlice.slicedRuns, 1);
  const sliced = withSlice.runs.find((r) => r.sliced === true);
  assert.ok(sliced, 'a sliced run should be marked');
  assert.equal(sliced!.failureIds?.length, 20);
  assert.equal(sliced!.failures, 20, 'a slice counts its own failures, not the whole run');
});

test('a slice names the exact failures, and the same seed names the same ones', () => {
  const runs = [runOf('b/collapse', 300, 'jest')];
  const a = sampleForLabelling(runs, { targetFailures: 30, sliceLargeRuns: 15, seed: 7 });
  const b = sampleForLabelling(runs, { targetFailures: 30, sliceLargeRuns: 15, seed: 7 });
  assert.deepEqual(a.runs[0]!.failureIds, b.runs[0]!.failureIds);
  assert.equal(new Set(a.runs[0]!.failureIds).size, 15, 'no duplicate failure ids in a slice');
});

test('one repository cannot supply every slice', () => {
  // Three collapses from one repo. Without the cap the sample is one project.
  const runs = [
    runOf('hog/mono', 300, 'jest'),
    runOf('hog/mono', 300, 'jest'),
    runOf('hog/mono', 300, 'jest'),
    runOf('other/app', 20, 'pytest'),
  ];
  const r = sampleForLabelling(runs, {
    targetFailures: 200,
    sliceLargeRuns: 20,
    maxSlicesPerRepo: 1,
  });
  assert.equal(r.slicedRuns, 1, `expected 1 slice, got ${r.slicedRuns}`);
});

test('a small framework is covered rather than swamped by the corpus mix', () => {
  // pytest is ~5% of failures here. Proportional selection would give it almost
  // nothing; the coverage floor must pull it in anyway.
  const runs = [
    runOf('big/one', 300, 'jest'),
    runOf('big/two', 300, 'jest'),
    runOf('small/py', 16, 'pytest'),
  ];
  const r = sampleForLabelling(runs, {
    targetFailures: 100,
    sliceLargeRuns: 25,
    minPerFramework: 15,
  });
  assert.ok(
    (r.byFramework['pytest']?.failures ?? 0) >= 15,
    `pytest should reach the floor, got ${r.byFramework['pytest']?.failures ?? 0}`,
  );
});

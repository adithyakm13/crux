import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '@cruxci/core';
import { naiveLooseFingerprintGroups, runBaseline } from '../src/baseline.ts';
import { validateCorpusRun, validateRunLabels, type CorpusRun, type RunLabels } from '../src/schema.ts';
import { alignLabelers, renderFailure, renderRunHeader } from '../src/label.ts';

// ---------------------------------------------------------------------------
// Fixtures. These are hand-built so the expected score is knowable by hand;
// they are NOT a substitute for the corpus, which is what actually gates
// clustering quality (§27).
// ---------------------------------------------------------------------------

function makeRun(
  id: string,
  failures: { id: string; message: string; stack?: string; type?: string }[],
): CorpusRun {
  return {
    schemaVersion: SCHEMA_VERSION,
    corpusRunId: id,
    source: {
      provider: 'github-actions',
      repo: 'acme/app',
      providerRunId: id,
      runAttempt: 1,
      url: 'https://example.invalid/run',
      workflowName: 'ci',
      event: 'push',
      headSha: 'abc123',
      headBranch: 'main',
      artifactIds: ['1'],
      licenseSpdx: 'MIT',
      licenseRaw: 'MIT',
      retrievedAt: '2026-09-01T00:00:00.000Z',
    },
    fidelity: 'artifact',
    counts: {
      attempts: failures.length,
      failures: failures.length,
      passed: 0,
      skipped: 0,
      filesParsed: 1,
      filesRejected: 0,
    },
    warnings: [],
    failures: failures.map((f) => ({
      failureId: f.id,
      sourceFile: 'results.xml',
      producerAdapter: 'junit',
      shardIndex: 0,
      attemptIndex: 0,
      displayName: f.id,
      suitePath: ['suite'],
      filePath: 'tests/a.spec.ts',
      status: 'failed',
      durationMs: 100,
      errorType: f.type ?? 'AssertionError',
      message: f.message,
      stackText: f.stack ?? '    at charge (src/pay.ts:88:11)',
      stdout: null,
      stderr: null,
    })),
  };
}

function makeLabels(
  corpusRunId: string,
  labeler: string,
  groups: Record<string, string>,
): RunLabels {
  return {
    schemaVersion: SCHEMA_VERSION,
    corpusRunId,
    labeler,
    labeledAt: '2026-09-01T00:00:00.000Z',
    context: 'full',
    labels: Object.fromEntries(
      Object.entries(groups).map(([id, group]) => [
        id,
        { group, category: 'PRODUCT_REGRESSION' as const },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// The naive rule
// ---------------------------------------------------------------------------

test('the naive rule groups by loose fingerprint and nothing else', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
    { id: 'f3', message: 'connection pool exhausted', stack: '    at pool (src/db.ts:10:1)' },
  ]);
  const groups = naiveLooseFingerprintGroups(run);
  // f1 and f2 differ only in the asserted value, which loose normalization
  // collapses; f3 is a different failure entirely.
  assert.equal(groups.get('f1'), groups.get('f2'));
  assert.notEqual(groups.get('f1'), groups.get('f3'));
});

test('scoring a perfectly grouped run gives F1 = 1 with an interval', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
    { id: 'f3', message: 'connection pool exhausted', stack: '    at pool (src/db.ts:10:1)' },
  ]);
  const labels = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1', f2: 'g1', f3: 'g2' })]]);
  const report = runBaseline([run], labels, { labeler: 'alice' });
  assert.equal(report.aggregate.f1, 1);
  assert.equal(report.runsScored, 1);
  assert.equal(report.pairsScored, 3);
  assert.equal(report.f1Interval.n, 1);
});

test('a run the labeler never touched is excluded, not scored as agreement', () => {
  const scored = makeRun('r1', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
  ]);
  const unlabelled = makeRun('r2', [
    { id: 'f1', message: 'something else entirely', stack: '    at x (src/x.ts:1:1)' },
    { id: 'f2', message: 'another thing', stack: '    at y (src/y.ts:1:1)' },
  ]);
  const labels = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1', f2: 'g1' })]]);
  const report = runBaseline([scored, unlabelled], labels, { labeler: 'alice' });
  assert.equal(report.runsScored, 1);
  assert.equal(report.runsExcluded.length, 1);
  assert.equal(report.runsExcluded[0]!.reason, 'no labels');
});

test('a partially labelled run scores only the labelled failures', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
    { id: 'f3', message: 'unlabelled failure', stack: '    at z (src/z.ts:1:1)' },
  ]);
  const labels = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1', f2: 'g1' })]]);
  const report = runBaseline([run], labels, { labeler: 'alice' });
  assert.equal(report.failuresScored, 2);
  assert.equal(report.pairsScored, 1);
});

test('a run with fewer than two labelled failures contributes no pairs and is excluded', () => {
  const run = makeRun('r1', [{ id: 'f1', message: 'only one failure here' }]);
  const labels = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1' })]]);
  const report = runBaseline([run], labels, { labeler: 'alice' });
  assert.equal(report.runsScored, 0);
  assert.match(report.runsExcluded[0]!.reason, /needs 2 to contribute a pair/);
});

test('per-run scores are reported so a catastrophic run cannot hide in the mean', () => {
  const good = makeRun('good', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
  ]);
  const bad = makeRun('bad', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
  ]);
  const labels = new Map([
    ['good', makeLabels('good', 'alice', { f1: 'g1', f2: 'g1' })],
    // Same payloads, but the labeller says these are different causes: the
    // naive rule cannot possibly get this run right.
    ['bad', makeLabels('bad', 'alice', { f1: 'g1', f2: 'g2' })],
  ]);
  const report = runBaseline([good, bad], labels, { labeler: 'alice' });
  assert.equal(report.perRun.length, 2);
  const byId = new Map(report.perRun.map((r) => [r.corpusRunId, r]));
  assert.equal(byId.get('good')!.f1, 1);
  assert.ok(!(byId.get('bad')!.f1 > 0), 'the bad run should not score above zero');
  assert.ok(report.aggregate.f1 < 1, 'the aggregate must reflect the bad run');
});

test('the report is reproducible', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'expected 200, got 500' },
    { id: 'f2', message: 'expected 200, got 503' },
  ]);
  const labels = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1', f2: 'g1' })]]);
  const a = runBaseline([run], labels, { labeler: 'alice' });
  const b = runBaseline([run], labels, { labeler: 'alice' });
  assert.deepEqual(a.f1Interval, b.f1Interval);
});

// ---------------------------------------------------------------------------
// Schema validation guards the measurement instrument
// ---------------------------------------------------------------------------

test('a corpus run with duplicate failure ids is rejected', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'a' },
    { id: 'f1', message: 'b' },
  ]);
  assert.throws(() => validateCorpusRun(run, 'test'), /duplicate failureId/);
});

test('a label referencing an unknown failure is rejected rather than ignored', () => {
  const run = makeRun('r1', [{ id: 'f1', message: 'a' }]);
  const labels = makeLabels('r1', 'alice', { f1: 'g1', f9: 'g2' });
  assert.throws(() => validateRunLabels(labels, 'test', run), /unknown failureId f9/);
});

test('an unknown category is rejected', () => {
  const run = makeRun('r1', [{ id: 'f1', message: 'a' }]);
  const labels = makeLabels('r1', 'alice', { f1: 'g1' });
  (labels.labels['f1'] as { category: string }).category = 'NOT_A_CATEGORY';
  assert.throws(() => validateRunLabels(labels, 'test', run), /is not one of/);
});

test('a future schema version is rejected rather than read optimistically', () => {
  const run = makeRun('r1', [{ id: 'f1', message: 'a' }]);
  run.schemaVersion = SCHEMA_VERSION + 1;
  assert.throws(() => validateCorpusRun(run, 'test'), /newer than this build supports/);
});

// ---------------------------------------------------------------------------
// Labeling contamination guards (§2)
// ---------------------------------------------------------------------------

test('payload-only rendering withholds repository, branch and commit', () => {
  const run = makeRun('r1', [{ id: 'f1', message: 'a' }]);
  const full = renderRunHeader(run, { context: 'full' });
  const payload = renderRunHeader(run, { context: 'payload-only' });
  assert.match(full, /acme\/app/);
  assert.match(full, /abc123/);
  for (const secret of ['acme/app', 'abc123', 'main', 'example.invalid']) {
    assert.ok(!payload.includes(secret), `payload-only header leaked ${secret}`);
  }
});

test('a rendered failure never contains a predicted cluster or category', () => {
  const run = makeRun('r1', [{ id: 'f1', message: 'expected 200, got 500' }]);
  const rendered = renderFailure(run.failures[0]!, 0, 1, { context: 'full' });
  const forbidden = ['cluster', 'predicted', 'PRODUCT_REGRESSION', 'fp_v'];
  for (const f of forbidden) {
    assert.ok(!rendered.toLowerCase().includes(f.toLowerCase()), `rendering leaked "${f}"`);
  }
});

test('labelers are aligned only on failures both actually labelled', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'a' },
    { id: 'f2', message: 'b' },
    { id: 'f3', message: 'c' },
  ]);
  const a = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1', f2: 'g1', f3: 'g2' })]]);
  const b = new Map([['r1', makeLabels('r1', 'bob', { f1: 'h1', f2: 'h2' })]]);
  const { aligned } = alignLabelers([run], a, b);
  assert.equal(aligned.length, 1);
  assert.deepEqual(aligned[0]!.failureIds, ['f1', 'f2']);
});

test('group ids are namespaced per labeler so partitions are compared, not names', () => {
  const run = makeRun('r1', [
    { id: 'f1', message: 'a' },
    { id: 'f2', message: 'b' },
  ]);
  // Both labelers used the name "g1", but for different failures. Comparing
  // raw names would report agreement that does not exist.
  const a = new Map([['r1', makeLabels('r1', 'alice', { f1: 'g1', f2: 'g1' })]]);
  const b = new Map([['r1', makeLabels('r1', 'bob', { f1: 'g1', f2: 'g2' })]]);
  const { aligned } = alignLabelers([run], a, b);
  assert.notDeepEqual(aligned[0]!.aGroups, aligned[0]!.bGroups);
  assert.ok(aligned[0]!.aGroups.every((g) => g.startsWith('a:')));
  assert.ok(aligned[0]!.bGroups.every((g) => g.startsWith('b:')));
});

/**
 * The console's data bundle.
 *
 * The console must not be able to show a figure the CLI would not, so the only
 * thing worth testing here is that the snapshot derives rather than computes:
 * the gate block comes straight from `gateZeroStatus`, the hold-out split
 * matches the licence rule, and a held-out run is marked rather than dropped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/snapshot.ts';
import { gateZeroStatus } from '../src/status.ts';
import { newCorpusRun, type CorpusRun } from '../src/schema.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let seq = 0;

function runWith(n: number, licenseSpdx: string | null, repo = 'acme/app'): CorpusRun {
  const run = newCorpusRun({
    fidelity: 'artifact',
    source: {
      provider: 'github-actions',
      repo,
      providerRunId: String(++seq),
      runAttempt: 1,
      licenseSpdx,
      licenseRaw: licenseSpdx,
      url: null,
      workflowName: 'CI',
      headSha: 'abc',
      headBranch: 'main',
      event: 'push',
      artifactIds: [],
      retrievedAt: '2026-01-01T00:00:00.000Z',
    } as never,
  });
  run.failures = Array.from({ length: n }, (_, i) => ({
    failureId: `f${i}`,
    sourceFile: 'results.xml',
    producerAdapter: 'junit',
    shardIndex: 0,
    attemptIndex: 0,
    displayName: `test ${i}`,
    suitePath: ['suite'],
    filePath: 'test/a.spec.ts',
    status: 'failed',
    durationMs: 5,
    errorType: 'AssertionError',
    message: 'boom',
    stackText: '  at thing (src/a.ts:1:1)',
    stdout: null,
    stderr: null,
  })) as never;
  return run;
}

const emptyCorpus = () => mkdtemp(join(tmpdir(), 'crux-snapshot-'));

test('the gate block is the CLI figure, not a second computation', async () => {
  const dir = await emptyCorpus();
  const runs = [runWith(6, 'MIT'), runWith(3, 'Apache-2.0', 'acme/other')];
  const snap = await buildSnapshot(dir, runs, () => 1000);
  const direct = await gateZeroStatus(dir, runs);
  assert.deepEqual(snap.gate.requirements, direct.requirements);
  assert.equal(snap.gate.runs, direct.runs);
});

test('a held-out run is marked and kept, never silently dropped', async () => {
  const dir = await emptyCorpus();
  const runs = [runWith(5, 'MIT'), runWith(5, 'GPL-3.0'), runWith(5, null)];
  const snap = await buildSnapshot(dir, runs, () => 1000);
  assert.equal(snap.runs.length, 3, 'all runs must appear');
  const held = snap.runs.filter((r) => r.heldOut !== null);
  assert.equal(held.length, 2);
  assert.ok(held.some((r) => r.heldOut?.startsWith('copyleft')));
  assert.ok(held.some((r) => r.heldOut?.startsWith('unidentified')));
});

test('an oversized run is held out on size, whatever its licence', async () => {
  const dir = await emptyCorpus();
  const snap = await buildSnapshot(dir, [runWith(2, 'MIT')], () => 60 * 1024 * 1024);
  assert.ok(snap.runs[0]?.heldOut?.startsWith('oversized'), snap.runs[0]?.heldOut ?? 'null');
});

test('size bands count committable runs only', async () => {
  const dir = await emptyCorpus();
  const runs = [runWith(1, 'MIT'), runWith(8, 'MIT'), runWith(8, 'AGPL-3.0')];
  const snap = await buildSnapshot(dir, runs, () => 1000);
  const band = (b: string) => snap.sizeBands.find((x) => x.band === b)?.runs ?? 0;
  assert.equal(band('1'), 1);
  assert.equal(band('5-24'), 1, 'the copyleft run must not be counted');
});

test('a corpus with no labels yields no labellers and no baselines', async () => {
  const dir = await emptyCorpus();
  const snap = await buildSnapshot(dir, [runWith(4, 'MIT')], () => 1000);
  assert.deepEqual(snap.labelers, []);
  assert.deepEqual(snap.baselines, []);
});

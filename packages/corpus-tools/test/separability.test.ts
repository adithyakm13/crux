/**
 * The separability guard.
 *
 * docs/evidence.md and the project documentation both state that "the
 * separability command refuses to score a labeler whose stored context is not
 * payload-only" and that this behaviour is asserted by test. It was not — the
 * guard the entire separability number depends on had no test at all, and the
 * claim that it did was itself the kind of unsupported assertion the project
 * forbids. These are that test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { separabilityReport } from '../src/commands.ts';
import { emptyLabels, saveLabels } from '../src/label.ts';
import { writeRun } from '../src/harvest.ts';
import { newCorpusRun } from '../src/schema.ts';

type Ctx = 'full' | 'payload-only';

/**
 * A corpus with one run of `n` failures, plus one label file per labeler.
 * `categories[labeler][i]` is that labeler's category for failure i.
 */
async function fixture(
  labelers: { name: string; context: Ctx; categories: string[] }[],
  n = 6,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crux-sep-'));

  // Built with the real helpers, so the fixture cannot drift from the format
  // the harvester actually writes.
  const run = newCorpusRun({
    fidelity: 'artifact',
    source: {
      provider: 'github-actions',
      repo: 'acme/app',
      providerRunId: '1',
      attempt: 1,
      licenseSpdx: 'MIT',
      licenseRaw: 'MIT',
      url: 'https://example.invalid/1',
      harvestedAt: '2026-01-01T00:00:00.000Z',
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
    durationMs: 1,
    errorType: 'AssertionError',
    message: `failure ${i}`,
    stackText: `  at thing (src/a.ts:${i}:1)`,
    stdout: null,
    stderr: null,
  })) as never;
  run.counts = { ...run.counts, attempts: n, failures: n, filesParsed: 1 };
  await writeRun(dir, run);

  for (const l of labelers) {
    const labels = emptyLabels(run.corpusRunId, l.name, l.context);
    l.categories.forEach((category, i) => {
      labels.labels[`f${i}`] = { category: category as never, group: `g${i % 2}` };
    });
    await saveLabels(dir, labels);
  }
  return dir;
}

const SIX = (c: string) => Array.from({ length: 6 }, () => c);

test('separability refuses to score a full-context labeler as payload-only', async () => {
  const dir = await fixture([
    { name: 'alice', context: 'full', categories: SIX('ENVIRONMENT_FAILURE') },
    { name: 'bob', context: 'full', categories: SIX('ENVIRONMENT_FAILURE') },
  ]);
  await assert.rejects(separabilityReport(dir, 'alice', 'bob'), (e: Error) => {
    assert.match(e.message, /payload-only/);
    assert.match(e.message, /fabricate/);
    return true;
  });
});

test('separability refuses to compare two payload-only labelers', async () => {
  // This is inter-labeler agreement under the restricted condition, not
  // separability. Reporting it as separability would read as evidence for the
  // payload-only thesis while containing none.
  const dir = await fixture([
    { name: 'alice', context: 'payload-only', categories: SIX('ENVIRONMENT_FAILURE') },
    { name: 'bob', context: 'payload-only', categories: SIX('ENVIRONMENT_FAILURE') },
  ]);
  await assert.rejects(separabilityReport(dir, 'alice', 'bob'), (e: Error) => {
    assert.match(e.message, /not\s+"full"/);
    return true;
  });
});

test('separability scores a genuine full vs payload-only pair', async () => {
  const dir = await fixture([
    {
      name: 'alice',
      context: 'full',
      categories: [
        'ENVIRONMENT_FAILURE',
        'ENVIRONMENT_FAILURE',
        'TEST_DEFECT',
        'TEST_DEFECT',
        'DATA_FAILURE',
        'DATA_FAILURE',
      ],
    },
    {
      name: 'bob',
      context: 'payload-only',
      categories: [
        'ENVIRONMENT_FAILURE',
        'ENVIRONMENT_FAILURE',
        'TEST_DEFECT',
        'UNKNOWN',
        'DATA_FAILURE',
        'UNKNOWN',
      ],
    },
  ]);
  const report = await separabilityReport(dir, 'alice', 'bob');
  assert.equal(report.compared, 6);
  assert.equal(report.agreed, 4);
  // The rate is an interval over runs, never a bare point estimate.
  assert.ok(Math.abs(report.rate.point - 4 / 6) < 1e-9);
  assert.equal(report.rate.method, 'bootstrap-percentile');
});

test('rendering a failure never emits a terminal escape sequence', async () => {
  // §4: strip ANSI and control characters before anything is printed to a
  // terminal. Corpus payloads are stored raw on purpose — normalization is
  // specified to see them — so the strip has to happen at the render boundary,
  // and 29 of 92 failures in the real corpus carry a raw ESC.
  const { loadRuns } = await import('../src/harvest.ts');
  const { renderFailure, renderRunHeader } = await import('../src/label.ts');
  const corpus = new URL('../../../corpus', import.meta.url).pathname;
  const runs = await loadRuns(corpus);
  if (runs.length === 0) return; // corpus not present in this checkout
  const esc = String.fromCharCode(27);
  const hazard = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
  let checked = 0;
  for (const run of runs) {
    for (const context of ['full', 'payload-only'] as const) {
      assert.ok(!renderRunHeader(run, { context }).includes(esc));
    }
    for (const [i, f] of run.failures.entries()) {
      for (const context of ['full', 'payload-only'] as const) {
        const out = renderFailure(f, i, run.failures.length, { context });
        assert.ok(!out.includes(esc), `ESC survived rendering ${f.failureId}`);
        assert.ok(!hazard.test(out), `control char survived rendering ${f.failureId}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'expected to render at least one failure');
});

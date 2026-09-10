/**
 * The offline labelling worksheet.
 *
 * It exists so a 156-failure sitting does not have to happen in a readline
 * loop, and so a second labeller — which Gate 0 requires — can be handed a file
 * rather than a toolchain.
 *
 * The tests that matter are the contamination guards, not the round trip. A
 * worksheet is the one place a labelling condition could be quietly changed
 * after the fact, and the corpus is the thing every other number is checked
 * against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorksheet, parseWorksheet } from '../src/worksheet.ts';
import { newCorpusRun, type CorpusRun } from '../src/schema.ts';

let seq = 0;

function runWith(n: number, repo = 'acme/app'): CorpusRun {
  const run = newCorpusRun({
    fidelity: 'artifact',
    source: {
      provider: 'github-actions',
      repo,
      providerRunId: String(++seq),
      attempt: 1,
      licenseSpdx: 'MIT',
      licenseRaw: 'MIT',
      url: 'https://example.invalid/1',
      harvestedAt: '2026-01-01T00:00:00.000Z',
      workflowName: 'CI',
      headSha: 'deadbeef',
      headBranch: 'main',
      event: 'push',
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
    message: `boom ${i}`,
    stackText: `  at thing (src/a.ts:${i}:1)`,
    stdout: 'some stdout',
    stderr: null,
  })) as never;
  return run;
}

const selOf = (run: CorpusRun, failureIds?: string[]) => ({
  digest: 'abc123',
  runs: [failureIds ? { corpusRunId: run.corpusRunId, failureIds } : { corpusRunId: run.corpusRunId }],
});

test('a full worksheet carries the payload and two blank fields', () => {
  const run = runWith(3);
  const { worksheet: ws } = buildWorksheet([run], selOf(run), 'full');
  assert.equal(ws.entries.length, 3);
  assert.equal(ws.context, 'full');
  assert.equal(ws.selectionDigest, 'abc123');
  const e = ws.entries[0]!;
  assert.equal(e.group, '');
  assert.equal(e.category, '');
  assert.ok(e.message.length > 0 && e.stack !== null, 'payload must be present to judge on');
  assert.ok(ws.categories.includes('UNKNOWN'), 'categories must be listed in the file');
  assert.ok(ws.instructions.join(' ').includes('ROOT CAUSE'));
});

test('a payload-only worksheet withholds provenance', () => {
  // This is the separability condition. If the file leaks repo or commit, the
  // rate measured from it is not the rate it claims to be.
  const run = runWith(2);
  const { worksheet: ws, key } = buildWorksheet([run], selOf(run), 'payload-only');
  assert.equal(ws.context, 'payload-only');
  for (const e of ws.entries) {
    assert.equal(e.repo, undefined);
    assert.equal(e.workflow, undefined);
    assert.equal(e.commit, undefined);
    // and the payload is still there, or there is nothing to judge
    assert.ok(e.message.length > 0);
  }
  const blob = JSON.stringify(ws);
  assert.ok(!blob.includes('acme/app'), 'the repository name leaked into a payload-only worksheet');
  assert.ok(!blob.includes('deadbeef'), 'the commit leaked into a payload-only worksheet');
});

test('a slice yields only its named failures', () => {
  const run = runWith(10);
  const { worksheet: ws } = buildWorksheet([run], selOf(run, ['f1', 'f4', 'f7']), 'full');
  assert.deepEqual(ws.entries.map((e) => e.failureId), ['f1', 'f4', 'f7']);
});

test('round trip: filled entries import as labels, blanks are skipped', () => {
  const run = runWith(4);
  const { worksheet: ws } = buildWorksheet([run], selOf(run), 'full');
  ws.entries[0]!.group = 'one-cause';
  ws.entries[0]!.category = 'PRODUCT_REGRESSION';
  ws.entries[1]!.group = 'one-cause';
  ws.entries[1]!.category = 'PRODUCT_REGRESSION';
  ws.entries[1]!.note = 'same broken call';
  ws.entries[2]!.group = 'other';
  ws.entries[2]!.category = 'unknown'; // lowercase must be accepted
  // entry 3 left blank

  const r = parseWorksheet(JSON.parse(JSON.stringify(ws)), 'alice', '2026-01-01T00:00:00.000Z');
  assert.equal(r.filled, 3);
  assert.equal(r.blank, 1);
  assert.equal(r.labels.length, 1);
  const labels = r.labels[0]!;
  assert.equal(labels.labeler, 'alice');
  assert.equal(labels.context, 'full');
  assert.equal(labels.labels['f0']!.group, 'one-cause');
  assert.equal(labels.labels['f1']!.note, 'same broken call');
  assert.equal(labels.labels['f2']!.category, 'UNKNOWN');
  assert.equal(labels.labels['f3'], undefined, 'a blank entry must not become a label');
});

test('the context travels with the file and cannot be swapped on import', () => {
  // The attack this prevents is quiet: label with full context, then import as
  // payload-only, and the separability rate becomes a number about nothing.
  const run = runWith(2);
  const { worksheet: ws, key } = buildWorksheet([run], selOf(run), 'payload-only');
  ws.entries[0]!.group = 'g';
  ws.entries[0]!.category = 'UNKNOWN';
  const r = parseWorksheet(JSON.parse(JSON.stringify(ws)), 'bob', '2026-01-01T00:00:00.000Z', key);
  assert.equal(r.context, 'payload-only');
  assert.equal(r.labels[0]!.context, 'payload-only');
});

test('a malformed worksheet is rejected, never repaired', () => {
  const run = runWith(3);
  const base = () => JSON.parse(JSON.stringify(buildWorksheet([run], selOf(run), 'full').worksheet));

  assert.throws(() => parseWorksheet(null, 'a', 'now'), /not a JSON object/);
  assert.throws(() => parseWorksheet({ context: 'full', entries: [] }, 'a', 'now'), /no entries/);

  const noCtx = base();
  delete noCtx.context;
  assert.throws(() => parseWorksheet(noCtx, 'a', 'now'), /context/);

  const badCat = base();
  badCat.entries[0].group = 'g';
  badCat.entries[0].category = 'DEFINITELY_NOT_A_CATEGORY';
  assert.throws(() => parseWorksheet(badCat, 'a', 'now'), /is not a category/);

  const groupOnly = base();
  groupOnly.entries[0].group = 'g';
  assert.throws(() => parseWorksheet(groupOnly, 'a', 'now'), /no category/);

  const catOnly = base();
  catOnly.entries[0].category = 'FLAKY';
  assert.throws(() => parseWorksheet(catOnly, 'a', 'now'), /no group/);

  const noId = base();
  delete noId.entries[0].failureId;
  delete noId.entries[0].corpusRunId;
  noId.entries[0].entryId = 'tampered';
  noId.entries[0].group = 'g';
  noId.entries[0].category = 'FLAKY';
  assert.throws(() => parseWorksheet(noId, 'a', 'now'), /cannot resolve/);
});

test('entries spanning several runs import as separate label files', () => {
  const a = runWith(2, 'acme/one');
  const b = runWith(2, 'acme/two');
  const { worksheet: ws } = buildWorksheet([a, b], {
    digest: 'd',
    runs: [{ corpusRunId: a.corpusRunId }, { corpusRunId: b.corpusRunId }],
  }, 'full');
  for (const e of ws.entries) {
    e.group = 'g-' + e.corpusRunId;
    e.category = 'ENVIRONMENT_FAILURE';
  }
  const r = parseWorksheet(JSON.parse(JSON.stringify(ws)), 'carol', 'now');
  assert.equal(r.labels.length, 2, 'one RunLabels per run');
  assert.equal(r.filled, 4);
});

test('a selection naming a run the corpus lacks fails loudly', () => {
  const run = runWith(1);
  assert.throws(
    () => buildWorksheet([run], { digest: 'd', runs: [{ corpusRunId: 'nope:1:1' }] }, 'full'),
    /not in the corpus/,
  );
});

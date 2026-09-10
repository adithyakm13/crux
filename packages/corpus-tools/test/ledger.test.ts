/**
 * The labelling page.
 *
 * The page is a rendering of a worksheet, so the tests worth having are the
 * ones about what the rendering can add: provenance that the worksheet withheld,
 * and markup that failure text can inject. Everything else the worksheet tests
 * already cover.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLedger, templatePath } from '../src/ledger.ts';
import { buildWorksheet } from '../src/worksheet.ts';
import { newCorpusRun, type CorpusRun } from '../src/schema.ts';

let seq = 0;

function runWith(n: number, over: Partial<Record<string, unknown>> = {}): CorpusRun {
  const run = newCorpusRun({
    fidelity: 'artifact',
    source: {
      provider: 'github-actions',
      repo: 'secretco/private-thing',
      providerRunId: String(++seq),
      attempt: 1,
      licenseSpdx: 'MIT',
      licenseRaw: 'MIT',
      url: 'https://example.invalid/1',
      harvestedAt: '2026-01-01T00:00:00.000Z',
      workflowName: 'nightly-canary',
      headSha: 'cafebabe1234',
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
    stackText: '  at thing (src/a.ts:1:1)',
    stdout: null,
    stderr: null,
    ...over,
  })) as never;
  return run;
}

const selOf = (run: CorpusRun) => ({ digest: 'abc123', runs: [{ corpusRunId: run.corpusRunId }] });

test('the template still carries the placeholder the builder replaces', async () => {
  // A template edited without this in mind would ship a page with no data and
  // no error, which is the failure mode most likely to reach a labeller.
  const tpl = await readFile(templatePath(), 'utf8');
  assert.ok(tpl.includes('/*__ENTRIES__*/'), 'placeholder missing from the template');
  assert.ok(tpl.includes('crux-data'), 'data block missing from the template');
});

test('a payload-only worksheet cannot produce a page that knows the repository', async () => {
  const run = runWith(3);
  const { worksheet } = buildWorksheet([run], selOf(run), 'payload-only');
  const html = await buildLedger(worksheet);
  for (const secret of ['secretco/private-thing', 'nightly-canary', 'cafebabe1234']) {
    assert.ok(!html.includes(secret), `${secret} leaked into a payload-only page`);
  }
  assert.ok(html.includes('e0001'), 'the opaque entry ids must still be there');
});

test('a full-context page carries provenance, since that is what full context means', async () => {
  const run = runWith(2);
  const { worksheet } = buildWorksheet([run], selOf(run), 'full');
  const html = await buildLedger(worksheet);
  assert.ok(html.includes('secretco/private-thing'));
  assert.ok(html.includes('"context":"full"'));
});

test('failure text cannot close the data block and become markup', async () => {
  // CI logs contain arbitrary bytes. An unescaped </script> would end the JSON
  // block early and spill the rest of the corpus into the document as HTML.
  const run = runWith(1, { message: 'unexpected </script><img src=x onerror=alert(1)>' });
  const { worksheet } = buildWorksheet([run], selOf(run), 'full');
  const html = await buildLedger(worksheet);
  assert.ok(!html.includes('</script><img'), 'the closing tag survived unescaped');
  assert.ok(html.includes('<\\/script>'), 'expected the escaped form in the data block');
});

test('only the listed fields reach the page', async () => {
  const run = runWith(1);
  const { worksheet } = buildWorksheet([run], selOf(run), 'full');
  // A field the worksheet gains later must not reach a page by accident.
  (worksheet.entries[0] as unknown as Record<string, unknown>)['internalNote'] = 'do-not-ship';
  const html = await buildLedger(worksheet);
  assert.ok(!html.includes('do-not-ship'));
});

test('a template without the placeholder is refused, not silently shipped', async () => {
  const run = runWith(1);
  const { worksheet } = buildWorksheet([run], selOf(run), 'full');
  await assert.rejects(() => buildLedger(worksheet, { template: '<title>nope</title>' }), /placeholder/);
});

test('the two contexts produce two differently named pages', async () => {
  // They are open side by side — primary pass and blind pass — and a labeller
  // who confuses the tabs has silently destroyed the separability measurement.
  const run = runWith(1);
  const full = await buildLedger(buildWorksheet([run], selOf(run), 'full').worksheet);
  const blind = await buildLedger(buildWorksheet([run], selOf(run), 'payload-only').worksheet);
  assert.ok(full.includes('<title>Root Cause Ledger</title>'));
  assert.ok(blind.includes('<title>Sealed Ledger</title>'));
  assert.ok(!blind.includes('Root Cause Ledger'), 'the full-context name must not survive');
});

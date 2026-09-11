/**
 * Which runs may be committed.
 *
 * This decides what leaves the machine, so the tests are about the boundary
 * rather than the formatting: an SPDX id that should be held out and is not
 * puts copyleft content into git history, and the generator must not eat
 * hand-written rules in the same file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLDOUT_BEGIN,
  HOLDOUT_END,
  holdOutReason,
  isHeldOut,
  renderGitignore,
} from '../src/license.ts';
import type { CorpusRun } from '../src/schema.ts';

const runWith = (licenseSpdx: string | null, licenseRaw: string | null = licenseSpdx) =>
  ({ source: { licenseSpdx, licenseRaw, repo: 'a/b' }, failures: [] }) as unknown as CorpusRun;

test('permissive licences are committable', () => {
  for (const l of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Unlicense']) {
    assert.equal(holdOutReason(runWith(l)), null, `${l} should be committable`);
  }
});

test('copyleft is held out, including the weak and the less common', () => {
  for (const l of ['GPL-3.0', 'GPL-2.0', 'LGPL-3.0', 'AGPL-3.0', 'EUPL-1.2', 'SSPL-1.0', 'OSL-3.0']) {
    const r = holdOutReason(runWith(l));
    assert.equal(r?.kind, 'copyleft', `${l} should be held out`);
  }
});

test('a licence GitHub could not identify is not the same as none, and both are held out', () => {
  // NOASSERTION means a LICENSE file exists that GitHub failed to classify.
  // Treating it as unlicensed, or as permissive, are both wrong; it is unknown.
  assert.deepEqual(holdOutReason(runWith(null, 'NOASSERTION')), {
    kind: 'unidentified',
    detail: 'NOASSERTION',
  });
  assert.deepEqual(holdOutReason(runWith(null, null)), { kind: 'unidentified', detail: 'none' });
  assert.equal(isHeldOut(runWith('NOASSERTION')), true);
});

test('a substring match must not hold out a permissive licence', () => {
  // "AGPL" inside a longer id, or a licence merely starting with the letters,
  // would be a silent over-block that quietly shrinks the committed corpus.
  assert.equal(holdOutReason(runWith('Apache-2.0')), null);
  assert.equal(holdOutReason(runWith('CC0-1.0')), null);
  assert.equal(holdOutReason(runWith('GPL-3.0-or-later'))?.kind, 'copyleft');
});

test('rendering replaces its own block and leaves hand-written rules alone', () => {
  const before = 'node_modules\ndist\n\n' + HOLDOUT_BEGIN + '\ncorpus/runs/old\n' + HOLDOUT_END + '\n*.log\n';
  const after = renderGitignore(before, ['corpus/runs/b', 'corpus/runs/a']);
  assert.ok(after.includes('node_modules'), 'hand-written rules above were dropped');
  assert.ok(after.includes('*.log'), 'hand-written rules below were dropped');
  assert.ok(!after.includes('corpus/runs/old'), 'the previous generated list survived');
  const body = after.slice(after.indexOf(HOLDOUT_BEGIN), after.indexOf(HOLDOUT_END));
  assert.ok(body.indexOf('corpus/runs/a') < body.indexOf('corpus/runs/b'), 'not sorted');
});

test('rendering appends a block when the file has none', () => {
  const after = renderGitignore('dist\n', ['corpus/runs/a']);
  assert.ok(after.startsWith('dist\n'));
  assert.ok(after.includes(HOLDOUT_BEGIN) && after.includes(HOLDOUT_END));
  // Running it twice must not stack two blocks.
  const twice = renderGitignore(after, ['corpus/runs/a']);
  assert.equal(twice.split(HOLDOUT_BEGIN).length - 1, 1);
});

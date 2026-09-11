/**
 * Importing labels a published page captured.
 *
 * The page keys everything by opaque entry id, so the whole risk is resolving
 * those ids to the wrong failure. A label on the wrong failure is worse than a
 * failed import because nothing downstream would ever notice it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importLedgerDocs } from '../src/db-import.ts';
import type { WorksheetKey } from '../src/worksheet.ts';

const key: WorksheetKey = {
  schemaVersion: 1,
  selectionDigest: 'd',
  entries: {
    e0001: { corpusRunId: 'p:a/b:1:1', failureId: 'f0001' },
    e0002: { corpusRunId: 'p:a/b:1:1', failureId: 'f0002' },
    e0003: { corpusRunId: 'p:c/d:2:1', failureId: 'f0001' },
  },
};

test('filled documents become labels, grouped by run', () => {
  const r = importLedgerDocs(
    [
      { id: 'e0001', group: 'one', category: 'FLAKY' },
      { id: 'e0002', group: 'one', category: 'flaky', note: ' shared cause ' },
      { id: 'e0003', group: 'two', category: 'TEST_DEFECT' },
    ],
    key, 'alice', 'now', 'full',
  );
  assert.equal(r.filled, 3);
  assert.equal(r.labels.length, 2, 'one RunLabels per run');
  const first = r.labels.find((l) => l.corpusRunId === 'p:a/b:1:1')!;
  assert.equal(first.labels['f0001']!.category, 'FLAKY');
  assert.equal(first.labels['f0002']!.category, 'FLAKY', 'lowercase must be accepted');
  assert.equal(first.labels['f0002']!.note, 'shared cause', 'note must be trimmed');
});

test('a blank document is skipped, never turned into a label', () => {
  const r = importLedgerDocs(
    [{ id: 'e0001', group: '', category: '' }, { id: 'e0002', group: 'g', category: 'FLAKY' }],
    key, 'a', 'now', 'full',
  );
  assert.equal(r.blank, 1);
  assert.equal(r.filled, 1);
});

test('an id the key does not know is reported, not guessed', () => {
  const r = importLedgerDocs(
    [{ id: 'e9999', group: 'g', category: 'FLAKY' }],
    key, 'a', 'now', 'full',
  );
  assert.deepEqual(r.unresolved, ['e9999']);
  assert.equal(r.filled, 0);
  assert.equal(r.labels.length, 0);
});

test('half-filled and undefined categories are refused', () => {
  assert.throws(
    () => importLedgerDocs([{ id: 'e0001', group: 'g' }], key, 'a', 'now', 'full'),
    /no category/,
  );
  assert.throws(
    () => importLedgerDocs([{ id: 'e0001', category: 'FLAKY' }], key, 'a', 'now', 'full'),
    /no group/,
  );
  assert.throws(
    () => importLedgerDocs([{ id: 'e0001', group: 'g', category: 'NOPE' }], key, 'a', 'now', 'full'),
    /is not a category/,
  );
});

test('the context travels from the caller, so a sealed pass cannot import as full', () => {
  const r = importLedgerDocs(
    [{ id: 'e0001', group: 'g', category: 'UNKNOWN' }],
    key, 'bob', 'now', 'payload-only',
  );
  assert.equal(r.labels[0]!.context, 'payload-only');
});

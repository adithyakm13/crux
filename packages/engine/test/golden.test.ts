/**
 * Golden output for normalization, keyed by NORMALIZE_VERSION.
 *
 * This exists to make NORMALIZE_VERSION load-bearing. It was declared in
 * versions.ts and referenced nowhere — so a rule could change, every
 * fingerprint in the corpus could change with it, and the version claiming to
 * track that would sit unchanged. A review flagged it and a skeptic refuted it
 * on the grounds that FINGERPRINT_VERSION covers the identifier. That is true
 * only while someone remembers to bump FINGERPRINT_VERSION by hand, which is
 * not a mechanism.
 *
 * Now it is one. Change any rule's observable output and this test fails with
 * the diff. Bumping NORMALIZE_VERSION and writing a new golden file is a
 * deliberate act that shows up in review, which is the point: §3 requires that
 * rows from different algorithm versions are never silently compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NORMALIZE_VERSION } from '@cruxci/core';
import { normalize, type NormalizeMode } from '../src/normalize.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, '__golden__', `normalize-v${NORMALIZE_VERSION}.json`);

/**
 * Inputs chosen to exercise every rule at least once, including the shapes that
 * have caused real defects: doubled whitespace before a duration, a stack line
 * number that a bare port rule would eat, prose either side of an assertion,
 * and a Windows path.
 */
const CORPUS: string[] = [
  'AssertionError: expected 200, got 500',
  'expected user to be logged in, got anonymous',
  'expected cart to be empty, got 3 items',
  'Expected: 200\nReceived: 500',
  'took 250  ms',
  'took 250 ms',
  'timed out after 30s waiting for locator',
  'at fn (src/a.ts:1234)',
  'at fn (src/a.ts:5678)',
  'connect ECONNREFUSED 127.0.0.1:8080',
  'dial localhost:3000 failed',
  'GET http://api.example.com:8080/v1/orders/42?token=abc',
  'connect [::1]:5432 refused',
  'request 550e8400-e29b-41d4-a716-446655440000 failed',
  'commit deadbeefcafebabe0123456789abcdef0123 not found',
  'segfault at 0x7ffd0000',
  'created 2026-01-02T03:04:05.678Z',
  'epoch 1767322800000 out of range',
  'wrote /tmp/pytest-of-runner/xyz/report.xml',
  'wrote C:\\Users\\runner\\AppData\\Local\\Temp\\out.xml',
  'user_4242 not found for acct-99',
  'notify test1234@example.com failed',
  'worker 7 died; shard-3 retry 2 aborted',
  '  File "tests/test_a.py", line 5, in test_x',
  '\tsrc/main.go:42 +0x1',
  ' \u276f run src/a.ts:9:3',
  'a\n   \n   \n   \nb',
  '',
];

async function readGolden(): Promise<Record<string, { strict: string; loose: string }> | null> {
  if (!existsSync(GOLDEN)) return null;
  return JSON.parse(await readFile(GOLDEN, 'utf8')) as Record<
    string,
    { strict: string; loose: string }
  >;
}

function compute(): Record<string, { strict: string; loose: string }> {
  const out: Record<string, { strict: string; loose: string }> = {};
  for (const input of CORPUS) {
    out[input] = {
      strict: normalize(input, 'strict' as NormalizeMode),
      loose: normalize(input, 'loose' as NormalizeMode),
    };
  }
  return out;
}

test(`normalization output matches the golden file for v${NORMALIZE_VERSION}`, async () => {
  const actual = compute();
  const golden = await readGolden();

  if (golden === null) {
    // Writing the file is deliberate and reviewable; creating it silently on a
    // changed algorithm would defeat the whole mechanism.
    if (process.env['CRUX_WRITE_GOLDEN'] === '1') {
      await mkdir(dirname(GOLDEN), { recursive: true });
      await writeFile(GOLDEN, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      return;
    }
    assert.fail(
      `No golden file for NORMALIZE_VERSION ${NORMALIZE_VERSION} at ${GOLDEN}.\n` +
        `If you intentionally changed normalization, bump NORMALIZE_VERSION and ` +
        `FINGERPRINT_VERSION, then run:\n  CRUX_WRITE_GOLDEN=1 node --test ${GOLDEN.replace(/__golden__.*/, '')}golden.test.ts`,
    );
  }

  for (const input of CORPUS) {
    const want = golden[input];
    assert.ok(
      want !== undefined,
      `golden file has no entry for ${JSON.stringify(input)} — the corpus grew; ` +
        `regenerate with CRUX_WRITE_GOLDEN=1 (no version bump needed for a new input)`,
    );
    assert.deepEqual(
      actual[input],
      want,
      `normalization changed for ${JSON.stringify(input)} without a version bump.\n` +
        `  strict: ${JSON.stringify(want!.strict)} -> ${JSON.stringify(actual[input]!.strict)}\n` +
        `  loose:  ${JSON.stringify(want!.loose)} -> ${JSON.stringify(actual[input]!.loose)}\n` +
        `If deliberate: bump NORMALIZE_VERSION and FINGERPRINT_VERSION in ` +
        `packages/core/src/versions.ts, then regenerate with CRUX_WRITE_GOLDEN=1.`,
    );
  }
});

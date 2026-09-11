/**
 * Payload caps.
 *
 * The tests that matter are about honesty and idempotence. A truncated record
 * that does not say it was truncated turns the corpus from evidence into
 * something a labeller cannot trust, and a compaction that compounds on a
 * second run loses the original length that makes it auditable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactFailure, truncateField, DEFAULT_MAX_FIELD_BYTES } from '../src/compact.ts';

test('a field under the cap is returned untouched', () => {
  const s = 'x'.repeat(100);
  assert.equal(truncateField(s, 1000), s);
  assert.equal(truncateField(s, 100), s);
});

test('truncation keeps the head and the tail, because the cause is often last', () => {
  // "Caused by:" chains and pytest's final assertion land at the end of a
  // stack. A head-only cut discards the half that usually carries the answer.
  const body = 'HEAD' + 'x'.repeat(10_000) + 'CAUSED-BY-THE-REAL-THING';
  const out = truncateField(body, 300);
  assert.ok(out.startsWith('HEAD'), 'head lost');
  assert.ok(out.endsWith('CAUSED-BY-THE-REAL-THING'), 'tail lost');
  assert.ok(out.includes('truncated'), 'the cut is not announced');
  assert.ok(out.length < 600, `far over the cap: ${out.length}`);
});

test('the original length is recorded, so the cut is auditable', () => {
  const f: Record<string, unknown> = {
    message: 'short',
    stackText: 'y'.repeat(200_000),
    stdout: null,
    stderr: 'z'.repeat(150_000),
  };
  const r = compactFailure(f, 1000);
  assert.equal(r.fieldsTruncated, 2);
  assert.ok(r.charactersDropped > 340_000);
  assert.deepEqual(f['truncated'], { stackText: 200_000, stderr: 150_000 });
  assert.equal(f['message'], 'short', 'a short field must not be marked');
  assert.equal(f['stdout'], null, 'null must not become a string');
});

test('compacting twice does not compound or rewrite the original length', () => {
  const f: Record<string, unknown> = { stackText: 'y'.repeat(50_000) };
  compactFailure(f, 1000);
  const afterFirst = f['stackText'];
  const second = compactFailure(f, 1000);
  assert.equal(second.fieldsTruncated, 0, 'a capped field was cut again');
  assert.equal(f['stackText'], afterFirst);
  assert.deepEqual(f['truncated'], { stackText: 50_000 });
});

test('the default cap is generous for a stack and small against a log dump', () => {
  assert.equal(DEFAULT_MAX_FIELD_BYTES, 65_536);
  const realisticStack = Array.from({ length: 200 }, (_, i) => `  at com.example.Thing${i}.run(Thing.java:${i})`).join('\n');
  const f: Record<string, unknown> = { stackText: realisticStack };
  assert.equal(compactFailure(f).fieldsTruncated, 0, 'a normal stack must survive intact');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../src/fingerprint.ts';
import { classifyFrame, deepestAppFrame, parseStack } from '../src/frames.ts';
import {
  MIN_SKETCH_CHARS,
  estimateJaccard,
  bandKeys,
  levenshteinSimilarity,
  minhash,
} from '../src/minhash.ts';

// ---------------------------------------------------------------------------
// Frame classification (§6)
// ---------------------------------------------------------------------------

test('classifies vendor, runner, test and app frames', () => {
  assert.equal(classifyFrame('/repo/node_modules/foo/index.js', null), 'framework');
  assert.equal(classifyFrame('/usr/lib/python3.11/site-packages/_pytest/runner.py', null), 'framework');
  assert.equal(classifyFrame('node:internal/process/task_queues', null), 'framework');
  assert.equal(classifyFrame(null, 'org.junit.runners.ParentRunner.run'), 'framework');
  assert.equal(classifyFrame('/repo/tests/api/orders.spec.ts', null), 'test');
  assert.equal(classifyFrame('/repo/src/api/orders.ts', null), 'app');
  assert.equal(classifyFrame('/repo/test_orders.py', null), 'test');
  assert.equal(classifyFrame('/repo/src/orders_test.go', null), 'test');
});

test('parses a V8 stack innermost-first and finds the deepest app frame', () => {
  const stack = [
    'Error: boom',
    '    at chargeCard (/repo/src/payments/charge.ts:88:11)',
    '    at processOrder (/repo/src/api/orders.ts:42:17)',
    '    at Object.<anonymous> (/repo/tests/api/orders.spec.ts:12:5)',
    '    at Promise.then (node:internal/process/task_queues:95:5)',
    '    at TestRunner._run (/repo/node_modules/@playwright/test/lib/runner.js:1:1)',
  ].join('\n');
  const frames = parseStack(stack);
  assert.deepEqual(
    frames.map((f) => f.kind),
    ['app', 'app', 'test', 'framework', 'framework'],
  );
  assert.equal(deepestAppFrame(frames)?.file, '/repo/src/payments/charge.ts');
  assert.equal(deepestAppFrame(frames)?.line, 88);
  assert.equal(frames[0]!.functionName, 'chargeCard');
});

test('a Python traceback is reversed so the deepest app frame is the innermost one', () => {
  // Python prints "most recent call last"; every other runtime prints the
  // reverse. Getting this backwards silently picks the wrong causal frame.
  const stack = [
    'Traceback (most recent call last):',
    '  File "/repo/tests/test_orders.py", line 12, in test_charge',
    '    process_order(o)',
    '  File "/repo/src/api/orders.py", line 42, in process_order',
    '    charge_card(o)',
    '  File "/repo/src/payments/charge.py", line 88, in charge_card',
    '    raise ValueError("boom")',
    'ValueError: boom',
  ].join('\n');
  const frames = parseStack(stack);
  assert.equal(frames[0]!.file, '/repo/src/payments/charge.py');
  assert.equal(deepestAppFrame(frames)?.file, '/repo/src/payments/charge.py');
});

test('a JVM stack classifies the runner and finds application code', () => {
  const stack = [
    'java.lang.AssertionError: expected 200',
    '\tat com.acme.orders.OrderService.charge(OrderService.java:88)',
    '\tat com.acme.orders.OrderTest.testCharge(OrderTest.java:12)',
    '\tat org.junit.runners.ParentRunner.run(ParentRunner.java:413)',
  ].join('\n');
  const frames = parseStack(stack);
  assert.equal(frames.at(-1)!.kind, 'framework');
  assert.equal(deepestAppFrame(frames)?.file, 'OrderService.java');
});

test('prose lines are not mistaken for frames', () => {
  const frames = parseStack('Error: request failed at the gateway\nCaused by: timeout');
  assert.deepEqual(frames, []);
});

// ---------------------------------------------------------------------------
// Hashing (§6)
// ---------------------------------------------------------------------------

const base = {
  errorType: 'AssertionError',
  message: 'expected 200, got 500',
  stackText: '    at chargeCard (/repo/src/payments/charge.ts:88:11)',
};

test('the same failure fingerprints identically every time', () => {
  const a = fingerprint(base);
  const b = fingerprint({ ...base });
  assert.equal(a.strictHash, b.strictHash);
  assert.equal(a.looseHash, b.looseHash);
  assert.match(a.id, /^fp_v\d+_[0-9a-f]{32}$/);
});

test('the algorithm version is inside the identifier', () => {
  assert.equal(fingerprint(base).id, `fp_v${fingerprint(base).algoVersion}_${fingerprint(base).strictHash}`);
});

test('a different asserted value changes strict but not loose', () => {
  const other = { ...base, message: 'expected 200, got 503' };
  assert.notEqual(fingerprint(base).strictHash, fingerprint(other).strictHash);
  assert.equal(fingerprint(base).looseHash, fingerprint(other).looseHash);
});

test('a different app frame changes both hashes', () => {
  const other = { ...base, stackText: '    at refund (/repo/src/payments/refund.ts:12:3)' };
  assert.notEqual(fingerprint(base).strictHash, fingerprint(other).strictHash);
  assert.notEqual(fingerprint(base).looseHash, fingerprint(other).looseHash);
});

test('framework noise above the app frame does not change the fingerprint', () => {
  // This is the whole point of frame classification: 38 framework frames must
  // not make two identical failures look different.
  const noisy = {
    ...base,
    stackText: [
      '    at chargeCard (/repo/src/payments/charge.ts:88:11)',
      '    at /repo/node_modules/@playwright/test/lib/worker.js:1:1',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n'),
  };
  assert.equal(fingerprint(base).strictHash, fingerprint(noisy).strictHash);
});

test('a stack with no app frame is reported rather than silently collapsed', () => {
  const fp = fingerprint({
    errorType: 'Error',
    message: 'runner crashed',
    stackText: '    at /repo/node_modules/@playwright/test/lib/worker.js:10:1',
  });
  assert.equal(fp.usedFrameFallback, true);
  assert.equal(fp.deepestAppFrame, null);
  // Distinct framework failures must still be distinguishable.
  const other = fingerprint({
    errorType: 'Error',
    message: 'runner crashed',
    stackText: '    at /repo/node_modules/@playwright/test/lib/dispatcher.js:10:1',
  });
  assert.notEqual(fp.strictHash, other.strictHash);
});

test('path separators do not change the fingerprint across platforms', () => {
  const posix = fingerprint({
    errorType: 'Error',
    message: 'boom',
    stackText: '    at fn (src/api/orders.ts:1:1)',
  });
  const windows = fingerprint({
    errorType: 'Error',
    message: 'boom',
    stackText: '    at fn (src\\api\\orders.ts:1:1)',
  });
  assert.equal(posix.strictHash, windows.strictHash);
});

test('the same failure from two machines fingerprints identically', () => {
  const ci = fingerprint(
    {
      errorType: 'AssertionError',
      message: 'expected 200, got 500 at 2026-09-01T00:00:00Z',
      stackText: '    at charge (/home/runner/work/app/app/src/pay.ts:88:11)',
    },
    { repoRoot: '/home/runner/work/app/app' },
  );
  const laptop = fingerprint(
    {
      errorType: 'AssertionError',
      message: 'expected 200, got 500 at 2026-08-14T09:15:22.113Z',
      stackText: '    at charge (/Users/dev/code/app/src/pay.ts:88:11)',
    },
    { repoRoot: '/Users/dev/code/app' },
  );
  assert.equal(ci.strictHash, laptop.strictHash);
});

test('an empty stack still produces a usable fingerprint', () => {
  const fp = fingerprint({ errorType: null, message: 'no stack here', stackText: null });
  assert.match(fp.strictHash, /^[0-9a-f]{32}$/);
  assert.equal(fp.usedFrameFallback, false);
});

// ---------------------------------------------------------------------------
// MinHash (§6)
// ---------------------------------------------------------------------------

test('short messages are not sketched', () => {
  assert.equal(minhash('too short'), null);
  assert.equal(minhash('x'.repeat(MIN_SKETCH_CHARS - 1)), null);
  assert.notEqual(minhash('x'.repeat(MIN_SKETCH_CHARS)), null);
});

test('identical text has estimated Jaccard 1', () => {
  const text = 'Timeout of 30000ms exceeded while waiting for locator to be visible';
  assert.equal(estimateJaccard(minhash(text)!, minhash(text)!), 1);
});

test('similar text scores high, unrelated text scores low', () => {
  const a = 'Timeout exceeded while waiting for the checkout button to become visible';
  const b = 'Timeout exceeded while waiting for the checkout banner to become visible';
  const c = 'Database connection pool exhausted after twenty seconds of retrying';
  const similar = estimateJaccard(minhash(a)!, minhash(b)!);
  const unrelated = estimateJaccard(minhash(a)!, minhash(c)!);
  assert.ok(similar > 0.6, `similar pair scored ${similar}`);
  assert.ok(unrelated < 0.2, `unrelated pair scored ${unrelated}`);
  assert.ok(similar > unrelated);
});

test('the sketch is deterministic, not seeded by process state', () => {
  const text = 'Timeout of 30000ms exceeded while waiting for locator to be visible';
  assert.deepEqual([...minhash(text)!], [...minhash(text)!]);
});

test('similar items share at least one band key, unrelated ones usually do not', () => {
  const a = 'Timeout exceeded while waiting for the checkout button to become visible';
  const b = 'Timeout exceeded while waiting for the checkout banner to become visible';
  const c = 'Database connection pool exhausted after twenty seconds of retrying';
  const ka = new Set(bandKeys(minhash(a)!));
  const kb = bandKeys(minhash(b)!);
  const kc = bandKeys(minhash(c)!);
  assert.ok(kb.some((k) => ka.has(k)), 'similar pair produced no candidate band');
  assert.ok(!kc.some((k) => ka.has(k)), 'unrelated pair became a candidate');
});

test('Levenshtein fallback behaves on the short strings it exists for', () => {
  assert.equal(levenshteinSimilarity('abc', 'abc'), 1);
  assert.equal(levenshteinSimilarity('', 'abc'), 0);
  assert.ok(levenshteinSimilarity('expected 5', 'expected 7') > 0.8);
  assert.ok(levenshteinSimilarity('expected 5', 'connection lost') < 0.4);
});

// ---------------------------------------------------------------------------
// pytest's failure format is not a traceback (§6)
// ---------------------------------------------------------------------------

test("pytest's own failure format yields frames", () => {
  // Without a parser for this shape, every pytest failure has zero frames and
  // the deepest-app-frame signal is unavailable for an entire framework.
  const text = [
    'self = <TestLogs object at 0x7f8>',
    '',
    '    def test_logs_action(self):',
    '>       assert response.status_code == 200',
    'E       assert 404 == 200',
    '',
    'products/logs/backend/test/test_logs.py:118: AssertionError',
  ].join('\n');
  const frames = parseStack(text);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.file, 'products/logs/backend/test/test_logs.py');
  assert.equal(frames[0]!.line, 118);
  assert.equal(frames[0]!.kind, 'test');
});

test('a pytest failure inside application code is found and ordered innermost-first', () => {
  const text = [
    'src/orders/service.py:42: in charge',
    '    raise ValueError("boom")',
    'src/payments/gateway.py:88: in send',
    '    resp.raise_for_status()',
  ].join('\n');
  const frames = parseStack(text);
  assert.deepEqual(
    frames.map((f) => f.file),
    ['src/payments/gateway.py', 'src/orders/service.py'],
  );
  assert.equal(deepestAppFrame(frames)?.file, 'src/payments/gateway.py');
});

test('loose normalization collapses assertion literals without eating the message', () => {
  // Regression guard: an earlier rule reduced every pytest failure to
  // "AssertionError: <val>", collapsing unrelated failures into one cluster.
  const a = fingerprint({ errorType: null, message: 'assert 0 >= 1', stackText: null });
  const b = fingerprint({ errorType: null, message: 'assert 3 >= 7', stackText: null });
  const c = fingerprint({
    errorType: null,
    message: 'assert response.status_code == 200',
    stackText: null,
  });
  assert.equal(a.looseHash, b.looseHash, 'same assertion, different data, must cluster');
  assert.notEqual(a.looseHash, c.looseHash, 'different assertions must not cluster');
  assert.match(a.normalizedRepr.loose, /assert <val> >= <val>/);
});

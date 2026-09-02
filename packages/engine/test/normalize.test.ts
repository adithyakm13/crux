import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, normalize, type NormalizeMode } from '../src/normalize.ts';

const ESC = String.fromCharCode(27);

// ---------------------------------------------------------------------------
// Properties (§5: mandatory)
// ---------------------------------------------------------------------------

/**
 * Inputs chosen to exercise every rule, plus the shapes that break naive
 * implementations: placeholders that a rule might re-match, adjacent
 * substitutions, and text that looks like several rules at once.
 */
const SAMPLES: string[] = [
  '',
  ' ',
  '\n\n\n',
  'plain failure with no interesting tokens',
  `${ESC}[31mAssertionError${ESC}[0m: expected 5, got 7`,
  'user 3f2504e0-4f89-41d3-9a0c-0305e82c3301 not found',
  'ULID 01ARZ3NDEKTSV4RRFFQ69G5FAV expired',
  'ObjectId 507f1f77bcf86cd799439011 missing',
  'commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 not found',
  'segfault at 0xdeadbeef in handler',
  'started at 2026-09-01T12:34:56.789Z and failed',
  'epoch 1788271411000 and 1788271411 both appear',
  'timed out after 30000ms (limit 5s, budget 2m)',
  'connect ECONNREFUSED 127.0.0.1:5432',
  'connect ECONNREFUSED [::1]:6379',
  'wrote /tmp/pytest-of-runner/pytest-13/test_foo0/out.txt',
  'wrote /var/folders/wb/abc123/T/playwright-artifacts/trace.zip',
  'read C:\\Users\\runner\\AppData\\Local\\Temp\\build\\log.txt',
  'GET https://api.example.com/v2/users/12345/orders?token=abc&x=1 failed',
  'no such user user_4821 (acct-99)',
  'mail to fixture12345@corp.io and someone@example.com bounced',
  'worker-3 shard_2 attempt 4 retry 1 all died',
  '    at handler (src/api/orders.ts:42:17)',
  'expected: {"a":1}\nReceived: {"a":2}',
  'Expected the button to be visible but it was hidden',
  'AssertionError: 1 != 2',
  '<id> <ts> <dur> <addr> <ip> <tmp> <home> <gen> <n> <val> :<port>',
  'nested <id> inside 0x1234 and 2026-01-01T00:00:00Z',
  'a'.repeat(5000),
  '\u0000\u0001\u0002 control soup \u001f',
  'unicode ✅ ❌ 日本語 emoji 🚀 stays',
];

for (const mode of ['strict', 'loose'] as const) {
  test(`normalization is idempotent in ${mode} mode`, () => {
    for (const input of SAMPLES) {
      const once = normalize(input, mode);
      const twice = normalize(once, mode);
      assert.equal(
        twice,
        once,
        `not idempotent for ${JSON.stringify(input.slice(0, 60))}:\n  once:  ${JSON.stringify(once)}\n  twice: ${JSON.stringify(twice)}`,
      );
    }
  });

  test(`normalization is total in ${mode} mode`, () => {
    for (const input of SAMPLES) {
      assert.doesNotThrow(() => normalize(input, mode));
    }
  });

  test(`every rule individually is idempotent in ${mode} mode`, () => {
    // A rule that is not idempotent on its own makes the whole cascade depend
    // on rule order in a way nobody can reason about.
    for (const rule of RULES) {
      for (const input of SAMPLES) {
        const once = rule.apply(input, mode, {});
        const twice = rule.apply(once, mode, {});
        assert.equal(twice, once, `rule ${rule.id} is not idempotent on ${JSON.stringify(input.slice(0, 50))}`);
      }
    }
  });
}

test('normalization is deterministic across repeated calls', () => {
  for (const input of SAMPLES) {
    assert.equal(normalize(input, 'strict'), normalize(input, 'strict'));
    assert.equal(normalize(input, 'loose'), normalize(input, 'loose'));
  }
});

test('every rule can be disabled by id, and an unknown id is an error', () => {
  for (const rule of RULES) {
    assert.doesNotThrow(() => normalize('anything', 'strict', { disabled: [rule.id] }));
  }
  assert.throws(() => normalize('x', 'strict', { disabled: ['no-such-rule'] }), /unknown rule/);
});

test('rule ids are unique', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// The strict/loose split is the load-bearing decision (§5)
// ---------------------------------------------------------------------------

test('strict keeps assertion values apart, loose collapses them', () => {
  const a = 'AssertionError: expected 5, got 7';
  const b = 'AssertionError: expected 5, got 9';
  assert.notEqual(normalize(a, 'strict'), normalize(b, 'strict'));
  assert.equal(normalize(a, 'loose'), normalize(b, 'loose'));
});

test('strict keeps stack line:col, loose drops it', () => {
  const a = 'at handler (src/api/orders.ts:42:17)';
  const b = 'at handler (src/api/orders.ts:88:3)';
  assert.notEqual(normalize(a, 'strict'), normalize(b, 'strict'));
  assert.equal(normalize(a, 'loose'), normalize(b, 'loose'));
});

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

const cases: [string, string, string][] = [
  ['uuid', 'id 3f2504e0-4f89-41d3-9a0c-0305e82c3301 gone', 'id <id> gone'],
  ['object-id', 'doc 507f1f77bcf86cd799439011 gone', 'doc <id> gone'],
  ['long-hex', 'sha a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 gone', 'sha <id> gone'],
  ['hex-address', 'at 0xdeadbeef here', 'at <addr> here'],
  ['iso-timestamp', 'at 2026-09-01T12:34:56.789Z ok', 'at <ts> ok'],
  ['epoch-ms', 'ts 1788271411000 ok', 'ts <ts> ok'],
  ['duration', 'took 30000ms ok', 'took <dur> ok'],
  ['ipv4', 'host 127.0.0.1 down', 'host <ip> down'],
  ['tmp', 'file /tmp/x/y.txt gone', 'file <tmp> gone'],
  ['url-query', 'GET https://a.io/p?x=1 failed', 'GET https://a.io/p failed'],
  ['generated-name', 'user_4821 missing', '<gen> missing'],
  ['worker-counter', 'worker-3 died', '<n> died'],
];

for (const [name, input, expected] of cases) {
  test(`rule ${name}: ${input}`, () => {
    assert.equal(normalize(input, 'strict'), expected);
  });
}

test('port normalization survives an IPv4 host', () => {
  assert.equal(normalize('ECONNREFUSED 127.0.0.1:5432', 'strict'), 'ECONNREFUSED <ip>:<port>');
});

test('a real-looking email is left alone, a seeded one is not', () => {
  assert.equal(normalize('mail alice@corp.io bounced', 'strict'), 'mail alice@corp.io bounced');
  assert.equal(normalize('mail fixture12345@corp.io bounced', 'strict'), 'mail <gen> bounced');
  assert.equal(normalize('mail alice@example.com bounced', 'strict'), 'mail <gen> bounced');
});

test('an ordinary large integer is not mistaken for an epoch', () => {
  // 9-digit and out-of-range values must survive: they are often the value the
  // assertion is actually about.
  assert.equal(normalize('expected 999999999 items', 'strict'), 'expected 999999999 items');
  assert.equal(normalize('expected 2500000000 items', 'strict'), 'expected 2500000000 items');
});

test('repoRoot makes an absolute path repo-relative', () => {
  assert.equal(
    normalize('at /home/runner/work/app/app/src/a.ts:1:2', 'strict', {
      repoRoot: '/home/runner/work/app/app',
    }),
    'at src/a.ts:1:2',
  );
});

test('home directories collapse even without an explicit homeDir', () => {
  assert.equal(normalize('at /Users/alice/proj/a.ts', 'strict'), 'at <home>/proj/a.ts');
  assert.equal(normalize('at /home/bob/proj/a.ts', 'strict'), 'at <home>/proj/a.ts');
});

test('ANSI and control characters are removed entirely', () => {
  const input = `${ESC}[31mred${ESC}[0m\u0000\u0007text`;
  assert.equal(normalize(input, 'strict'), 'redtext');
});

// ---------------------------------------------------------------------------
// Idempotency, as a property over generated input rather than hand-picked
// samples. The earlier version of this suite asserted idempotency over a fixed
// SAMPLES list that happened to avoid both real failure modes:
//   - "took 250  ms" kept its double space past the duration rule, so one pass
//     gave "took 250 ms" and a second gave "took <dur>";
//   - a whitespace-only line only becomes blank after trimming, so collapsing
//     blank-line runs first left newlines a second pass would collapse again.
// Generated input finds both immediately.
// ---------------------------------------------------------------------------

const TOKENS = [
  'AssertionError', 'expected', 'got', 'at', 'Error:', 'Timeout',
  '5', '7', '250', '1500', '0', '42',
  'ms', 's', 'm', 'took', 'after', 'waiting',
  ' ', '  ', '   ', '\t', '\n', '\n\n', '\n\n\n', '\r\n',
  ':8080', ':443', '127.0.0.1', 'http://host/a/1/b?q=2',
  '/tmp/x', '/var/folders/ab/c', '/Users/someone/p', 'C:\\Users\\x\\y.ts',
  '550e8400-e29b-41d4-a716-446655440000', 'deadbeefcafebabe0123456789abcdef',
  'src/app.ts:12:5', 'user_42', 'a@b.com', '0x7ffd', '"quoted"',
];

function generate(rng: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += TOKENS[Math.floor(rng() * TOKENS.length)]!;
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('normalizing twice equals normalizing once, over generated input', () => {
  const rng = lcg(0xc0ffee);
  const modes: NormalizeMode[] = ['strict', 'loose'];
  for (let i = 0; i < 3000; i++) {
    const input = generate(rng, 1 + Math.floor(rng() * 12));
    for (const mode of modes) {
      const once = normalize(input, mode);
      const twice = normalize(once, mode);
      assert.equal(
        twice,
        once,
        `not idempotent in ${mode} mode\n  input = ${JSON.stringify(input)}\n  once  = ${JSON.stringify(once)}\n  twice = ${JSON.stringify(twice)}`,
      );
    }
  }
});

test('every rule is idempotent on its own, over generated input', () => {
  const rng = lcg(0x5eed);
  for (const rule of RULES) {
    for (let i = 0; i < 400; i++) {
      const input = generate(rng, 1 + Math.floor(rng() * 8));
      for (const mode of ['strict', 'loose'] as NormalizeMode[]) {
        const once = rule.apply(input, mode, {});
        const twice = rule.apply(once, mode, {});
        assert.equal(
          twice,
          once,
          `rule "${rule.id}" is not idempotent in ${mode} mode\n  input = ${JSON.stringify(input)}\n  once  = ${JSON.stringify(once)}\n  twice = ${JSON.stringify(twice)}`,
        );
      }
    }
  }
});

test('whitespace spelling does not change the fingerprint input', () => {
  // The concrete defect: two CI producers emit the same timeout, one padded to
  // column width. They must not end up in different clusters.
  for (const mode of ['strict', 'loose'] as NormalizeMode[]) {
    assert.equal(normalize('took 250  ms', mode), normalize('took 250 ms', mode));
    assert.equal(normalize('expected 5,   got 7', mode), normalize('expected 5, got 7', mode));
    assert.equal(normalize('a\n   \n   \nb', mode), normalize('a\n\nb', mode));
  }
});

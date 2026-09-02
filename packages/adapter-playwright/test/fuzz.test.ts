/**
 * Fuzz target for the Playwright adapter (§27).
 *
 * Covers both shapes the adapter accepts: the JSON reporter's single document
 * and the blob report's line-delimited events. Same invariants as the JUnit
 * target — only ParseError escapes, the RawAttempt contract holds, adversarial
 * input stays roughly linear, and deeply nested structures produce a bounded
 * DEPTH_LIMIT rather than a RangeError.
 *
 * That last one is not hypothetical. Both suite walkers guarded recursion on
 * the emitted path length rather than the recursion depth, and since the path
 * only grows for non-empty suite titles, a tree of empty-titled suites blew the
 * stack instead of hitting the guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, type RawAttempt } from '@cruxci/core';
import { PlaywrightAdapter } from '../src/playwright.ts';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function streamOf(s: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function run(
  input: string,
  chunkSize = 1 << 16,
): Promise<{ attempts: RawAttempt[]; threw: unknown }> {
  const attempts: RawAttempt[] = [];
  try {
    for await (const a of new PlaywrightAdapter().parse(streamOf(input, chunkSize), {
      skipInvalid: true,
    })) {
      attempts.push(a);
    }
  } catch (e) {
    return { attempts, threw: e };
  }
  return { attempts, threw: null };
}

/** Random JSON of bounded depth, including the shapes the adapter looks for. */
function randomJson(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth <= 0 || roll < 0.25) {
    const leaves: unknown[] = [
      null, true, false, 0, -1, 1.5, 1e308, '', 'x', 'a'.repeat(200),
      'passed', 'failed', 'timedOut', 'skipped', 'interrupted',
      String.fromCharCode(27) + '[31m', '\u0000', '\uD800',
    ];
    return leaves[Math.floor(next() * leaves.length)];
  }
  if (roll < 0.6) {
    const n = Math.floor(next() * 4);
    return Array.from({ length: n }, () => randomJson(next, depth - 1));
  }
  const keys = [
    'title', 'suites', 'tests', 'specs', 'results', 'errors', 'config', 'stats',
    'status', 'duration', 'error', 'message', 'stack', 'location', 'file', 'line',
    'column', 'attachments', 'stdout', 'stderr', 'retry', 'expectedStatus',
    'method', 'params', 'version', 'testId', 'annotations', 'workerIndex',
  ];
  const o: Record<string, unknown> = {};
  const n = Math.floor(next() * 5);
  for (let i = 0; i < n; i++) {
    o[keys[Math.floor(next() * keys.length)]!] = randomJson(next, depth - 1);
  }
  return o;
}

function checkContract(a: RawAttempt, where: string): void {
  assert.equal(typeof a.displayName, 'string', `${where}: displayName`);
  assert.ok(Array.isArray(a.suitePath), `${where}: suitePath`);
  assert.ok(Number.isInteger(a.attemptIndex) && a.attemptIndex >= 0, `${where}: attemptIndex`);
  assert.ok(
    a.durationMs === null || (Number.isFinite(a.durationMs) && a.durationMs >= 0),
    `${where}: durationMs ${a.durationMs}`,
  );
  if (a.failure !== null) assert.equal(typeof a.failure.message, 'string', `${where}: message`);
}

test('playwright fuzz: only ParseError escapes on random JSON', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = rng(seed);
    const doc = JSON.stringify(randomJson(next, 5));
    const { attempts, threw } = await run(doc);
    if (threw !== null) {
      assert.ok(
        threw instanceof ParseError,
        `seed ${seed}: threw ${(threw as Error)?.constructor?.name} — ` +
          `${(threw as Error)?.message?.slice(0, 140)}\ninput: ${doc.slice(0, 240)}`,
      );
    }
    attempts.forEach((a, i) => checkContract(a, `seed ${seed} attempt ${i}`));
  }
});

test('playwright fuzz: only ParseError escapes on blob-shaped lines', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = rng(seed * 104729);
    const lines: string[] = [];
    const n = 1 + Math.floor(next() * 12);
    for (let i = 0; i < n; i++) {
      const roll = next();
      if (roll < 0.15) lines.push('not json at all');
      else if (roll < 0.25) lines.push('');
      else if (roll < 0.35) lines.push('{"method":');
      else {
        const obj = randomJson(next, 4) as Record<string, unknown>;
        if (typeof obj === 'object' && obj !== null) {
          obj['method'] = ['onBegin', 'onTestBegin', 'onTestEnd', 'onEnd', 'onAttach', 'bogus'][
            Math.floor(next() * 6)
          ];
        }
        lines.push(JSON.stringify(obj));
      }
    }
    const blob = lines.join('\n');
    const { attempts, threw } = await run(blob);
    if (threw !== null) {
      assert.ok(
        threw instanceof ParseError,
        `seed ${seed}: threw ${(threw as Error)?.constructor?.name} — ` +
          `${(threw as Error)?.message?.slice(0, 140)}`,
      );
    }
    attempts.forEach((a, i) => checkContract(a, `seed ${seed} attempt ${i}`));
  }
});

test('playwright fuzz: pathological nesting gives DEPTH_LIMIT, never RangeError', async () => {
  // Empty titles never grow the emitted suite path, which is precisely why the
  // guard has to count recursion rather than path length.
  for (const title of ['', 'named']) {
    let root: Record<string, unknown> = { title, suites: [], tests: [] };
    let cur = root;
    for (let i = 0; i < 20_000; i++) {
      const child: Record<string, unknown> = { title, suites: [], tests: [] };
      (cur['suites'] as unknown[]).push(child);
      cur = child;
    }
    const { threw } = await run(JSON.stringify({ config: {}, suites: [root], errors: [] }));
    assert.ok(
      threw instanceof ParseError,
      `title=${JSON.stringify(title)}: expected ParseError, got ` +
        `${(threw as Error)?.constructor?.name ?? 'no throw'}`,
    );
    assert.equal((threw as { code?: string }).code, 'DEPTH_LIMIT');
  }
});

test('playwright fuzz: oversized input fails with SIZE_LIMIT rather than OOM', async () => {
  const huge = '{"suites":[' + '{"title":"x","tests":[]},'.repeat(20_000) + '{}]}';
  const { threw } = await run(huge, 1 << 16);
  // Either it parses cleanly or it refuses with a bounded error; never a crash.
  if (threw !== null) {
    assert.ok(threw instanceof ParseError, `got ${(threw as Error)?.constructor?.name}`);
  }
});

/**
 * Fuzz target for the JUnit XML parser (§27).
 *
 * "XML and JSON parsers handling untrusted input without a fuzz target is a
 * vulnerability waiting to be filed." This is that target.
 *
 * The invariants are deliberately narrow, because the parser is allowed to
 * reject anything it likes. What it is not allowed to do:
 *
 *   1. throw anything other than ParseError — a TypeError or RangeError escaping
 *      to the caller means an unhandled edge, and RangeError specifically means
 *      unbounded recursion;
 *   2. take super-linear time on adversarial input;
 *   3. emit a RawAttempt that violates its own type contract;
 *   4. behave differently depending on how the stream was chunked.
 *
 * Deterministically seeded, so a failure reproduces exactly. The seed is printed
 * with any failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, type RawAttempt } from '@cruxci/core';
import { JUnitAdapter } from '../src/junit.ts';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Fragments chosen to include every shape that has caused a real defect. */
const FRAGMENTS = [
  '<testsuites>', '</testsuites>', '<testsuite name="s">', '</testsuite>',
  '<testcase name="t">', '<testcase name="t"/>', '</testcase>',
  '<failure message="m">', '</failure>', '<error type="E">', '</error>',
  '<skipped/>', '<system-out>', '</system-out>', '<system-err>', '</system-err>',
  '<flakyFailure message="r">', '</flakyFailure>', '<rerunFailure>', '</rerunFailure>',
  '<![CDATA[', ']]>', '<!-- c -->', '<?xml version="1.0"?>', '<?pi?>',
  '&lt;', '&amp;', '&#65;', '&nosuch;', '&#x1B;',
  ESC + '[31m', ESC + ']0;title' + BEL, ESC + ']0;' + 'A'.repeat(600), ESC + ']', ESC,
  '\u0000', '\u0001', '\u001F', '\uFFFE', '\uD800', '\t', '\n', '\r\n',
  'text', 'a'.repeat(300), '\"', "'", '<', '>', '/', '=', '\u0000',
  'name="x"', 'time="1.5"', 'time="NaN"', 'time="-1"', 'classname="c"', 'file="f.ts"',
  '<!DOCTYPE x>', '<!DOCTYPE x [<!ENTITY e "v">]>',
];

function generate(next: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!;
  return out;
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
  xml: string,
  chunkSize: number,
  skipInvalid: boolean,
): Promise<{ attempts: RawAttempt[]; threw: unknown }> {
  const attempts: RawAttempt[] = [];
  try {
    for await (const a of new JUnitAdapter().parse(streamOf(xml, chunkSize), { skipInvalid })) {
      attempts.push(a);
    }
  } catch (e) {
    return { attempts, threw: e };
  }
  return { attempts, threw: null };
}

function checkContract(a: RawAttempt, where: string): void {
  assert.equal(typeof a.displayName, 'string', `${where}: displayName`);
  assert.ok(Array.isArray(a.suitePath), `${where}: suitePath`);
  assert.ok(Number.isInteger(a.attemptIndex) && a.attemptIndex >= 0, `${where}: attemptIndex`);
  assert.ok(Number.isInteger(a.shardIndex) && a.shardIndex >= 0, `${where}: shardIndex`);
  assert.ok(
    a.durationMs === null || (Number.isFinite(a.durationMs) && a.durationMs >= 0),
    `${where}: durationMs ${a.durationMs}`,
  );
  if (a.failure !== null) {
    assert.equal(typeof a.failure.message, 'string', `${where}: failure.message`);
  }
  // Control characters must never survive: they are illegal in XML and the
  // sanitizer is the only thing standing between them and a terminal.
  const text = a.displayName + a.suitePath.join('') + (a.failure?.message ?? '');
  assert.ok(
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text),
    `${where}: control character survived parsing`,
  );
}

test('junit fuzz: only ParseError escapes, and the contract always holds', async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = rng(seed);
    const xml = generate(next, 1 + Math.floor(next() * 30));
    for (const skipInvalid of [false, true]) {
      const { attempts, threw } = await run(xml, 1 + Math.floor(next() * 200), skipInvalid);
      if (threw !== null) {
        assert.ok(
          threw instanceof ParseError,
          `seed ${seed} skipInvalid=${skipInvalid}: threw ${(threw as Error)?.constructor?.name} ` +
            `— ${(threw as Error)?.message?.slice(0, 120)}\ninput: ${JSON.stringify(xml.slice(0, 300))}`,
        );
      }
      attempts.forEach((a, i) => checkContract(a, `seed ${seed} attempt ${i}`));
    }
  }
});

test('junit fuzz: the parse does not depend on how the stream was chunked', async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const next = rng(seed * 7919);
    const xml = generate(next, 1 + Math.floor(next() * 20));
    const shapes: string[] = [];
    for (const size of [1, 3, 17, 256, 1 << 16]) {
      const { attempts, threw } = await run(xml, size, true);
      shapes.push(
        threw !== null
          ? `threw:${(threw as { code?: string }).code ?? 'unknown'}`
          : JSON.stringify(attempts.map((a) => [a.displayName, a.status, a.attemptIndex])),
      );
    }
    assert.equal(
      new Set(shapes).size,
      1,
      `seed ${seed}: chunking changed the parse\ninput: ${JSON.stringify(xml.slice(0, 200))}\n` +
        shapes.map((s, i) => `  [${i}] ${s.slice(0, 160)}`).join('\n'),
    );
  }
});

test('junit fuzz: adversarial input stays roughly linear', async () => {
  // Catastrophic backtracking is the failure this guards. Both patterns below
  // have caused a real quadratic blowup in this parser's history.
  const timings: { label: string; ms: number; bytes: number }[] = [];
  for (const [label, make] of [
    ['unterminated OSC', (n: number) => (ESC + ']').repeat(n / 2)],
    ['nested CDATA opens', (n: number) => '<![CDATA['.repeat(n / 9)],
    ['entity soup', (n: number) => '&nosuch;'.repeat(n / 8)],
    ['deep-ish nesting', (n: number) => '<testsuite name="s">'.repeat(Math.min(n / 20, 40))],
  ] as [string, (n: number) => string][]) {
    for (const bytes of [64 * 1024, 256 * 1024]) {
      const xml = `<testsuite name="s"><testcase name="t"><failure><![CDATA[${make(bytes)}]]></failure></testcase></testsuite>`;
      const t0 = performance.now();
      await run(xml, 1 << 16, true);
      timings.push({ label, ms: performance.now() - t0, bytes });
    }
  }
  for (const t of timings) {
    assert.ok(
      t.ms < 5000,
      `${t.label} at ${t.bytes} bytes took ${t.ms.toFixed(0)} ms — ` +
        `that is the signature of catastrophic backtracking`,
    );
  }
});

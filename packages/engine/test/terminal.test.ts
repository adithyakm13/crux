import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTerminalHazard, sanitizeForTerminal } from '../src/terminal.ts';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test('strips SGR colour sequences', () => {
  assert.equal(sanitizeForTerminal(`${ESC}[32m- Expected${ESC}[39m`), '- Expected');
});

test('strips cursor movement and screen clearing', () => {
  // These are the sequences that make injection matter: they overwrite text
  // already printed and hide what came before.
  assert.equal(sanitizeForTerminal(`safe${ESC}[2J${ESC}[1;1Hoverwritten`), 'safeoverwritten');
  assert.equal(sanitizeForTerminal(`a${ESC}[10Ab`), 'ab');
});

test('strips OSC sequences, including the clipboard-write form', () => {
  // OSC 52 writes the system clipboard in several emulators. A test name must
  // not be able to reach it.
  assert.equal(sanitizeForTerminal(`x${ESC}]52;c;cGF5bG9hZA==${BEL}y`), 'xy');
  assert.equal(sanitizeForTerminal(`x${ESC}]0;new title${ESC}\\y`), 'xy');
  // Unterminated: consumed rather than leaked, same as the ingest sanitizer.
  assert.equal(sanitizeForTerminal(`x${ESC}]0;unterminated`), 'x');
});

test('strips C0 controls and DEL but keeps tab and newline', () => {
  const NUL = String.fromCharCode(0);
  const BS = String.fromCharCode(8);
  const DEL = String.fromCharCode(127);
  assert.equal(sanitizeForTerminal(`a${NUL}b${BS}c${DEL}d`), 'abcd');
  assert.equal(sanitizeForTerminal('line1\nline2\tcol'), 'line1\nline2\tcol');
  // CR alone returns the cursor to column 0 and overwrites the line.
  assert.equal(sanitizeForTerminal('visible\rhidden'), 'visiblehidden');
});

test('makes bidi overrides visible rather than dropping them', () => {
  // Trojan Source: these reorder the display without changing the bytes, so a
  // test name can read as something other than what it is. Their presence is
  // itself the signal, so they are shown rather than removed.
  const out = sanitizeForTerminal('safe‮evil‬tail');
  assert.match(out, /<bidi>/);
  assert.ok(!out.includes('‮'));
});

test('leaves ordinary failure text untouched', () => {
  const text =
    'AssertionError: expected 200, got 500\n' +
    '    at charge (src/billing.ts:42:7)\n' +
    '    at Object.<anonymous> (test/pay.spec.ts:9:1)';
  assert.equal(sanitizeForTerminal(text), text);
});

test('is idempotent', () => {
  const dirty = `${ESC}[31ma${String.fromCharCode(0)}b${ESC}]0;t${BEL}c`;
  const once = sanitizeForTerminal(dirty);
  assert.equal(sanitizeForTerminal(once), once);
});

test('hasTerminalHazard agrees with what sanitizing changes', () => {
  const cases = [
    'plain text',
    `${ESC}[31mred`,
    'a${String.fromCharCode(0)}b',
    'bidi‮here',
    'tabs\tand\nnewlines are fine',
  ];
  for (const c of cases) {
    assert.equal(
      hasTerminalHazard(c),
      sanitizeForTerminal(c) !== c,
      `disagreement on ${JSON.stringify(c)}`,
    );
  }
});

test('an unterminated escape cannot cost quadratic time', () => {
  const hostile = (ESC + ']').repeat(512 * 1024);
  const t0 = performance.now();
  sanitizeForTerminal(hostile);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms — backtracking`);
});

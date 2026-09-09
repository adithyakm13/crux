/**
 * Adapter conformance suite (§24).
 *
 * "An extension point without a conformance test produces plugins that work on
 * the author's machine only." This is the suite every `TestResultAdapter` must
 * pass, in-tree ones and third-party ones alike.
 *
 * It ships from `@cruxci/core` rather than from a test directory because the
 * point is that someone outside this repository can run it against their own
 * adapter. It is deliberately runner-agnostic: it returns results rather than
 * calling `assert`, so it can be driven from node:test, vitest, or a script.
 *
 * What it checks is the contract, not the format:
 *
 *  1. Only `ParseError` escapes. A TypeError or RangeError reaching the caller
 *     means an unhandled edge; a RangeError specifically means unbounded
 *     recursion. Both were found in a real adapter by this class of test.
 *  2. Every emitted `RawAttempt` satisfies its type contract — no NaN duration,
 *     no negative index, no control characters surviving into a field that will
 *     be printed to a terminal.
 *  3. The parse does not depend on how the byte stream was chunked. A parser
 *     that answers differently at 1 byte and 64 KiB has a state-machine bug,
 *     and it will surface as flaky ingest rather than as a parse error.
 *  4. `capabilities()` is self-consistent, and the adapter does not emit data
 *     it declares it cannot supply.
 *  5. `detect()` is total: it answers for a missing file rather than throwing.
 *  6. Adversarial input is handled in bounded time.
 *
 * What it deliberately does NOT check: that any particular input parses to any
 * particular output. An adapter is free to reject whatever it likes — refusing
 * to parse is always a valid answer, and a suite that demanded successful
 * parses would force adapters to guess.
 */

import { ParseError, type Capabilities, type RawAttempt, type TestResultAdapter } from './adapter.ts';

export interface ConformanceCase {
  name: string;
  /** Bytes fed to the adapter. */
  input: string;
  /** Chunk sizes to feed it at; the parse must agree across all of them. */
  chunkSizes?: number[];
}

export interface ConformanceFinding {
  case: string;
  check: string;
  detail: string;
}

export interface ConformanceResult {
  adapter: string;
  casesRun: number;
  attemptsSeen: number;
  findings: ConformanceFinding[];
  passed: boolean;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const ESC = '\u001B';

/**
 * Inputs every adapter sees, regardless of format. Each is a shape that has
 * broken a real parser: empty input, a lone byte, truncation mid-token, a
 * hostile escape sequence, deep nesting, and a large repetitive body.
 */
export function baseCases(): ConformanceCase[] {
  return [
    { name: 'empty', input: '' },
    { name: 'whitespace only', input: '   \n\t\r\n  ' },
    { name: 'single byte', input: 'x' },
    { name: 'not this format', input: 'the quick brown fox\njumped over\n' },
    { name: 'nul byte', input: 'a\u0000b' },
    { name: 'lone surrogate', input: 'a\uD800b' },
    { name: 'bare escape', input: `a${ESC}b` },
    { name: 'unterminated OSC', input: `a${ESC}]${'A'.repeat(2000)}` },
    { name: 'ansi soup', input: `${ESC}[31m${ESC}[0m`.repeat(500) },
    { name: 'deep nesting', input: '['.repeat(5000) },
    { name: 'long line', input: 'a'.repeat(200_000) },
    { name: 'many newlines', input: '\n'.repeat(50_000) },
    { name: 'bom then junk', input: '\uFEFFnot a report' },
  ];
}

function streamOf(input: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function checkAttempt(
  a: RawAttempt,
  caps: Capabilities,
  add: (check: string, detail: string) => void,
): void {
  if (typeof a.displayName !== 'string') add('contract', 'displayName is not a string');
  if (!Array.isArray(a.suitePath)) add('contract', 'suitePath is not an array');
  if (!Number.isInteger(a.attemptIndex) || a.attemptIndex < 0) {
    add('contract', `attemptIndex is ${a.attemptIndex}`);
  }
  if (!Number.isInteger(a.shardIndex) || a.shardIndex < 0) {
    add('contract', `shardIndex is ${a.shardIndex}`);
  }
  if (a.durationMs !== null && (!Number.isFinite(a.durationMs) || a.durationMs < 0)) {
    add('contract', `durationMs is ${a.durationMs}`);
  }
  if (a.failure !== null && typeof a.failure.message !== 'string') {
    add('contract', 'failure.message is not a string');
  }

  const printed = a.displayName + a.suitePath.join('') + (a.failure?.message ?? '');
  if (printed.includes(ESC)) {
    add('terminal safety', 'an ANSI escape survived into a field that gets printed');
  }
  if (CONTROL_CHARS.test(printed)) {
    add('terminal safety', 'a control character survived into a field that gets printed');
  }

  if (!caps.durations && a.durationMs !== null) {
    add('capabilities', 'emitted a duration while declaring durations: false');
  }
  if (!caps.workerId && a.workerId !== null) {
    add('capabilities', 'emitted a workerId while declaring workerId: false');
  }
  if (!caps.attemptStartTime && a.startedAt !== null) {
    add('capabilities', 'emitted startedAt while declaring attemptStartTime: false');
  }
  if (!caps.structuredAssertion && a.failure?.assertion != null) {
    add('capabilities', 'emitted a structured assertion while declaring it unsupported');
  }
  if (!caps.artifacts && (a.failure?.artifacts.length ?? 0) > 0) {
    add('capabilities', 'emitted artifacts while declaring artifacts: false');
  }
}

/** Shape of one parse: enough to compare two chunkings for equality. */
function shapeOf(attempts: RawAttempt[]): string {
  return JSON.stringify(
    attempts.map((a) => [a.displayName, a.suitePath, a.status, a.attemptIndex, a.durationMs]),
  );
}

export interface ConformanceOptions {
  /** Format-specific cases on top of the universal ones. */
  extraCases?: ConformanceCase[];
  /** Per-case budget. Exceeding it is a finding, not a hang. */
  timeBudgetMs?: number;
}

export async function runConformance(
  adapter: TestResultAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceResult> {
  const budget = options.timeBudgetMs ?? 5000;
  const cases = [...baseCases(), ...(options.extraCases ?? [])];
  const findings: ConformanceFinding[] = [];
  let attemptsSeen = 0;

  const caps = adapter.capabilities();
  if (caps.structuredAssertion && !caps.stackTrace) {
    // Not impossible, but it has always meant a copy-paste error in practice.
    findings.push({
      case: '(capabilities)',
      check: 'capabilities',
      detail: 'declares structured assertions but no stack traces; verify that is real',
    });
  }

  // detect() must be total. A missing path is the case every caller hits first.
  try {
    const score = await adapter.detect('/nonexistent/crux-conformance/missing.file');
    if (typeof score !== 'number' || Number.isNaN(score) || score < 0 || score > 1) {
      findings.push({
        case: '(detect)',
        check: 'detect',
        detail: `detect() returned ${String(score)}; expected a number in [0,1]`,
      });
    }
  } catch (e) {
    findings.push({
      case: '(detect)',
      check: 'detect',
      detail: `detect() threw on a missing file: ${(e as Error).message.slice(0, 120)}`,
    });
  }

  for (const c of cases) {
    const chunkSizes = c.chunkSizes ?? [1, 7, 4096, 1 << 20];
    const shapes = new Set<string>();

    for (const size of chunkSizes) {
      const add = (check: string, detail: string) =>
        findings.push({ case: `${c.name} @${size}`, check, detail });

      const started = Date.now();
      const attempts: RawAttempt[] = [];
      try {
        for await (const a of adapter.parse(streamOf(c.input, size), { skipInvalid: true })) {
          attempts.push(a);
        }
        shapes.add(shapeOf(attempts));
      } catch (e) {
        if (e instanceof ParseError) {
          shapes.add(`threw:${e.code}`);
        } else {
          add(
            'error type',
            `threw ${(e as Error)?.constructor?.name ?? typeof e}: ` +
              `${String((e as Error)?.message).slice(0, 140)} — only ParseError may escape`,
          );
          shapes.add('threw:non-parse-error');
        }
      }
      const elapsed = Date.now() - started;
      if (elapsed > budget) {
        add('time', `took ${elapsed}ms (budget ${budget}ms) — likely catastrophic backtracking`);
      }
      for (const a of attempts) checkAttempt(a, caps, add);
      attemptsSeen += attempts.length;
    }

    if (shapes.size > 1) {
      findings.push({
        case: c.name,
        check: 'chunk independence',
        detail:
          `the parse differs across chunk sizes (${shapes.size} distinct results). ` +
          `A parser that answers differently at 1 byte and 1 MiB has a state-machine bug.`,
      });
    }
  }

  return {
    adapter: adapter.name,
    casesRun: cases.length,
    attemptsSeen,
    findings,
    passed: findings.length === 0,
  };
}

export function formatConformance(r: ConformanceResult): string {
  const lines: string[] = [];
  lines.push(
    `${r.adapter}: ${r.passed ? 'PASS' : 'FAIL'} — ${r.casesRun} case(s), ` +
      `${r.attemptsSeen} attempt(s), ${r.findings.length} finding(s)`,
  );
  for (const f of r.findings) lines.push(`  [${f.check}] ${f.case}: ${f.detail}`);
  return lines.join('\n');
}

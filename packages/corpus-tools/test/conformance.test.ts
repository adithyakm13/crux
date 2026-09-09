/**
 * Both in-tree adapters must pass the conformance suite (§24).
 *
 * The suite lives in `@cruxci/core` so a third-party adapter can run it too.
 * It is driven from here rather than from either adapter's own tests because
 * the point is that it is the *same* suite for every adapter — an adapter
 * cannot quietly weaken the contract by editing a copy next to itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConformance, runConformance, type ConformanceCase } from '@cruxci/core';
import { JUnitAdapter } from '@cruxci/adapter-junit';
import { PlaywrightAdapter } from '@cruxci/adapter-playwright';

const ESC = String.fromCharCode(27);

const JUNIT_CASES: ConformanceCase[] = [
  { name: 'valid minimal', input: '<testsuite name="s"><testcase name="t"/></testsuite>' },
  {
    name: 'failure with cdata',
    input:
      '<testsuite name="s"><testcase name="t"><failure message="m">' +
      '<![CDATA[at f (src/a.ts:1:1)]]></failure></testcase></testsuite>',
  },
  { name: 'truncated mid-tag', input: '<testsuites><testsuite name="s"><testcase nam' },
  { name: 'doctype', input: '<!DOCTYPE x><testsuite name="s"/>' },
  {
    name: 'ansi in cdata',
    input: `<testsuite name="s"><testcase name="t"><failure><![CDATA[${ESC}[31mred${ESC}[0m]]></failure></testcase></testsuite>`,
  },
];

const PLAYWRIGHT_CASES: ConformanceCase[] = [
  { name: 'valid json report', input: '{"config":{},"suites":[],"errors":[]}' },
  { name: 'json null', input: 'null' },
  { name: 'json scalar', input: '42' },
  { name: 'blob line null', input: 'null\n{"method":"onEnd"}' },
  { name: 'blob not json', input: '{"method":"onBegin"}\nnot json\n{"method":"onEnd"}' },
  { name: 'suites not an array', input: '{"suites":"nope"}' },
  { name: 'suite is null', input: '{"suites":[null,{"title":"x"}]}' },
];

test('the JUnit adapter conforms', async () => {
  const r = await runConformance(new JUnitAdapter(), { extraCases: JUNIT_CASES });
  assert.ok(r.passed, `\n${formatConformance(r)}`);
  assert.ok(r.casesRun > 10);
});

test('the Playwright adapter conforms', async () => {
  const r = await runConformance(new PlaywrightAdapter(), { extraCases: PLAYWRIGHT_CASES });
  assert.ok(r.passed, `\n${formatConformance(r)}`);
  assert.ok(r.casesRun > 10);
});

test('the suite actually fails a non-conforming adapter', async () => {
  // A suite that cannot fail proves nothing. This adapter breaks the contract
  // in three ways at once: it throws a TypeError, emits a negative index, and
  // lets an ANSI escape through into a printed field.
  const broken = {
    name: 'broken',
    capabilities: () => ({
      structuredAssertion: false,
      stdout: false,
      stderr: false,
      stackTrace: false,
      retries: false,
      attemptStartTime: false,
      durations: false,
      workerId: false,
      artifacts: false,
      skipped: false,
    }),
    detect: async () => {
      throw new Error('detect exploded');
    },
    async *parse() {
      yield {
        shardIndex: -1,
        displayName: `bad${ESC}[31m`,
        suitePath: [],
        filePath: null,
        attemptIndex: 0,
        status: 'failed' as const,
        durationMs: Number.NaN,
        startedAt: null,
        workerId: null,
        failure: null,
      };
      throw new TypeError('not a ParseError');
    },
  };

  const r = await runConformance(broken, { timeBudgetMs: 5000 });
  assert.equal(r.passed, false);
  const checks = new Set(r.findings.map((f) => f.check));
  assert.ok(checks.has('detect'), 'a throwing detect() must be caught');
  assert.ok(checks.has('error type'), 'a non-ParseError escaping must be caught');
  assert.ok(checks.has('contract'), 'a negative index and NaN duration must be caught');
  assert.ok(checks.has('terminal safety'), 'a surviving ANSI escape must be caught');
});

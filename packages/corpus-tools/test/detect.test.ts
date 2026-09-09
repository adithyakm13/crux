/**
 * Framework detection.
 *
 * Every fixture here is a real shape taken from the corpus, not an invented
 * one. The detector had no tests at all, which is how a Go pattern that
 * required whitespace after the line number — and therefore matched none of the
 * three shapes Go actually emits — got written and only caught by diffing
 * classifications across the whole corpus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFramework } from '../src/status.ts';

const detect = (stack: string, type: string | null = null, src = 'results.xml') =>
  detectFramework(src, stack, type);

test('JVM is detected from frame shape, without a junit package', () => {
  // Surefire trims runner frames, so requiring `org.junit` missed most of a
  // large repository's output.
  assert.equal(
    detect(
      'org.opentest4j.AssertionFailedError: \n[server 0 must hold]\nexpected: 10L\n but was: 7L\n' +
        '\tat com.arcadedb.server.ha.raft.Issue5569.mergedDeletes(Issue5569SlotMerge.java:118)',
      'org.opentest4j.AssertionFailedError',
    ),
    'junit-jvm',
  );
  assert.equal(
    detect(
      'java.io.IOException: Server returned HTTP response code: 503\n' +
        '\tat java.base/sun.net.www.protocol.http.HttpURLConnection.getInputStream0(HttpURLConnection.java:2034)',
      'java.io.IOException',
    ),
    'junit-jvm',
  );
  // Kotlin and Scala share the shape.
  assert.equal(detect('\tat com.acme.Thing.check(Thing.kt:42)'), 'junit-jvm');
  assert.equal(detect('\tat com.acme.Thing.check(Thing.scala:42)'), 'junit-jvm');
});

test('pytest is detected in both traceback shapes', () => {
  // CPython's.
  assert.equal(
    detect('  File "tests/test_orders.py", line 42, in test_charge\n    assert x == y'),
    'pytest',
  );
  // pytest's own short format, which shares no tokens with CPython's and sent
  // every failure in two repositories to `unknown`.
  assert.equal(
    detect(
      'tests/test_dashboard.py:284: in test_dashboard_profile\n' +
        '    with urllib.request.urlopen(request, timeout=5) as response:',
    ),
    'pytest',
  );
  // Windows separators in the same shape.
  assert.equal(detect('tests\\\\test_dashboard.py:284: in test_x\n    boom'), 'pytest');
});

test('Go is detected in every shape it emits', () => {
  // Bare, colon-suffixed, and line:col from the compiler. Requiring whitespace
  // after the line number matched none of the last two.
  assert.equal(detect('    project_test.go:447: \n        \tError Trace:\tpkl/project_test.go:447'), 'go-test');
  assert.equal(detect('pkl/evaluator_manager_test.go:109:7: undefined: newFakeEvaluatorManager'), 'go-test');
  assert.equal(detect('main.go:12 something'), 'go-test');
});

test('jest is detected from its assertion format when the word never appears', () => {
  // Next.js wraps the runner, so hundreds of unmistakably jest failures carried
  // no `jest` token anywhere.
  assert.equal(
    detect(
      'Error: expect(received).toBe(expected) // Object.is equality\n' +
        '    at Object.toBe (/work/nextjs/test/e2e/invalid-static-asset/page.test.ts:31:5)',
    ),
    'jest',
  );
  assert.equal(detect('Error: expect(received).toContain(expected) // indexOf'), 'jest');
});

test('vitest wins over the jest-style assertion it shares', () => {
  // Both print `expect(received)`, so ordering is what separates them: vitest's
  // heavy-arrow frame is checked first.
  const arrow = String.fromCharCode(0x276f);
  assert.equal(
    detect(`Error: expect(received).toBe(expected)\n ${arrow} run src/a.ts:9:3`),
    'vitest',
  );
});

test('a framework named in a test title is not evidence', () => {
  // The old detector raced substrings over one haystack, so a test *about*
  // Playwright counted as a Playwright failure.
  assert.equal(
    detect(
      '  File "tests/test_playwright_migration.py", line 8, in test_playwright_migration\n' +
        '    assert False',
    ),
    'pytest',
  );
});

test('a real package path is evidence', () => {
  assert.equal(
    detect('    at Page.click (/app/node_modules/@playwright/test/lib/page.js:1:1)'),
    'playwright',
  );
  assert.equal(
    detect('    at run (/app/node_modules/jest-circus/build/run.js:1:1)'),
    'jest',
  );
});

test('an unrecognisable payload stays unknown rather than being guessed', () => {
  assert.equal(detect('something went wrong'), 'unknown');
  assert.equal(detect(''), 'unknown');
  assert.equal(detectFramework('', null, null), 'unknown');
});

// ---------------------------------------------------------------------------
// Artifact dispatch. `corpus scan` and `corpus harvest` must ask the same
// question — a scan matching artifact *names* declared 27 repositories
// productive and the harvest then kept runs from one, because a
// `playwright-report/` of pure HTML passes any name filter and parses to
// nothing. Both now call pickAdapter, so this is the shared contract.
// ---------------------------------------------------------------------------

test('artifact dispatch is by content, not by filename', async () => {
  const { pickAdapter } = await import('../src/harvest.ts');
  const enc = (s: string) => new TextEncoder().encode(s);

  // Right extension, right content.
  assert.equal(
    pickAdapter('test-results/junit.xml', enc('<?xml version="1.0"?><testsuites><testsuite/>'))?.name,
    'junit',
  );
  assert.equal(
    pickAdapter('blob-report/report.jsonl', enc('{"method":"onBegin","params":{}}'))?.name,
    'playwright',
  );
  assert.equal(
    pickAdapter('report.json', enc('{"config":{},"suites":[],"errors":[]}'))?.name,
    'playwright',
  );

  // A promising name with useless content is the exact false positive that
  // wasted a harvest: an HTML report, a coverage file, an empty archive.
  assert.equal(pickAdapter('playwright-report/index.html', enc('<!doctype html><html>')), null);
  assert.equal(pickAdapter('test-results/index.html', enc('<!doctype html>')), null);
  assert.equal(pickAdapter('junit/coverage.xml', enc('<?xml version="1.0"?><coverage/>')), null);
  assert.equal(pickAdapter('test-report.json', enc('{"totals":{"lines":10}}')), null);
  assert.equal(pickAdapter('test-results.txt', enc('<testsuites/>')), null);
  assert.equal(pickAdapter('results.xml', enc('')), null);
});

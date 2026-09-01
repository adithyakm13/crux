import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUnitAdapter } from '../src/junit.ts';
import type { ParseOptions, ParseWarning, RawAttempt } from '@cruxci/core';

function streamOf(xml: string, chunkSize = 64): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(xml);
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

async function collect(
  xml: string,
  options: ParseOptions = {},
  chunkSize = 64,
): Promise<{ attempts: RawAttempt[]; warnings: ParseWarning[] }> {
  const warnings: ParseWarning[] = [];
  const adapter = new JUnitAdapter();
  const attempts: RawAttempt[] = [];
  for await (const a of adapter.parse(streamOf(xml, chunkSize), {
    ...options,
    onWarning: (w) => warnings.push(w),
  })) {
    attempts.push(a);
  }
  return { attempts, warnings };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('parses a failing testcase with suite path and duration', async () => {
  const { attempts } = await collect(`<?xml version="1.0"?>
<testsuites>
  <testsuite name="api" file="test/api.spec.ts">
    <testcase name="rejects an expired token" classname="AuthSuite" time="1.25">
      <failure message="expected 401, got 500" type="AssertionError">at Object.&lt;anonymous&gt; (test/api.spec.ts:42:7)</failure>
    </testcase>
  </testsuite>
</testsuites>`);

  assert.equal(attempts.length, 1);
  const a = attempts[0]!;
  assert.equal(a.displayName, 'rejects an expired token');
  assert.deepEqual(a.suitePath, ['api', 'AuthSuite']);
  assert.equal(a.filePath, 'test/api.spec.ts');
  assert.equal(a.status, 'failed');
  assert.equal(a.attemptIndex, 0);
  assert.equal(a.durationMs, 1250);
  assert.equal(a.failure?.errorType, 'AssertionError');
  assert.equal(a.failure?.message, 'expected 401, got 500');
  // Entities are decoded; only the five predefined ones exist without a DTD.
  assert.match(a.failure!.stackText!, /at Object\.<anonymous> \(test\/api\.spec\.ts:42:7\)/);
});

test('a passing testcase yields one passed attempt', async () => {
  const { attempts } = await collect(
    `<testsuite name="s"><testcase name="works" time="0.5"/></testsuite>`,
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.status, 'passed');
  assert.equal(attempts[0]!.failure, null);
  assert.equal(attempts[0]!.durationMs, 500);
});

test('skipped and error statuses are distinguished from failed', async () => {
  const { attempts } = await collect(`<testsuite name="s">
    <testcase name="skip"><skipped message="no browser"/></testcase>
    <testcase name="err"><error message="boom" type="RuntimeError">trace</error></testcase>
  </testsuite>`);
  assert.deepEqual(
    attempts.map((a) => a.status),
    ['skipped', 'error'],
  );
  assert.equal(attempts[0]!.failure, null);
  assert.equal(attempts[1]!.failure?.errorType, 'RuntimeError');
});

test('CDATA stack traces survive chunk boundaries intact', async () => {
  const stack = Array.from({ length: 40 }, (_, i) => `    at frame${i} (src/mod${i}.ts:${i}:1)`).join(
    '\n',
  );
  const xml = `<testsuite name="s"><testcase name="t"><failure message="m"><![CDATA[${stack}]]></failure></testcase></testsuite>`;
  // Chunk size 7 guarantees the CDATA is split many times.
  const { attempts } = await collect(xml, {}, 7);
  assert.equal(attempts[0]!.failure?.stackText, stack);
});

test('ANSI escape sequences are removed whole, never leaving bracket codes', async () => {
  // Real producers emit raw ESC into JUnit XML even though it is illegal in
  // XML 1.0. crux strips the whole sequence rather than the ESC alone, so no
  // `[2m` residue reaches normalization.
  const esc = String.fromCharCode(27);
  const msg = `Timeout ${esc}[2mwaiting${esc}[22m for locator`;
  const { attempts, warnings } = await collect(
    `<testsuite name="s"><testcase name="t"><failure><![CDATA[${msg}]]></failure></testcase></testsuite>`,
  );
  assert.equal(attempts[0]!.failure?.stackText, 'Timeout waiting for locator');
  const w = warnings.find((x) => x.code === 'CONTROL_CHARS_STRIPPED');
  assert.ok(w, 'stripping must be reported, never silent');
  assert.match(w!.message, /2 ANSI escape sequence/);
});

test('ANSI stripping does not depend on how the stream was chunked', async () => {
  const esc = String.fromCharCode(27);
  const msg = `a${esc}[31mred${esc}[0mb${esc}]8;;http://x\u0007link${esc}]8;;\u0007c`;
  const xml = `<testsuite name="s"><testcase name="t"><failure><![CDATA[${msg}]]></failure></testcase></testsuite>`;
  const results = [];
  for (const size of [1, 2, 3, 5, 7, 13, 64, 4096]) {
    const { attempts } = await collect(xml, {}, size);
    results.push(attempts[0]!.failure?.stackText);
  }
  assert.equal(new Set(results).size, 1, `chunking changed the result: ${JSON.stringify(results)}`);
  assert.equal(results[0], 'aredblinkc');
});

test('system-out and system-err attach to the failure', async () => {
  const { attempts } = await collect(`<testsuite name="s"><testcase name="t">
    <failure message="m">trace</failure>
    <system-out>stdout line</system-out>
    <system-err>stderr line</system-err>
  </testcase></testsuite>`);
  assert.equal(attempts[0]!.failure?.stdout, 'stdout line');
  assert.equal(attempts[0]!.failure?.stderr, 'stderr line');
});

// ---------------------------------------------------------------------------
// Attempt grain (§3): retries are never collapsed
// ---------------------------------------------------------------------------

test('surefire rerun elements become earlier attempts, final outcome last', async () => {
  const { attempts } = await collect(`<testsuite name="s">
    <testcase name="flaky one" time="2.0">
      <flakyFailure message="first try" type="E">t1</flakyFailure>
      <flakyFailure message="second try" type="E">t2</flakyFailure>
    </testcase>
  </testsuite>`);
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map((a) => [a.attemptIndex, a.status]),
    [
      [0, 'failed'],
      [1, 'failed'],
      [2, 'passed'],
    ],
  );
  assert.equal(attempts[0]!.failure?.message, 'first try');
  // Duration belongs to the testcase as a whole; inventing a split would be
  // fabricated data, so only the final attempt carries it.
  assert.deepEqual(
    attempts.map((a) => a.durationMs),
    [null, null, 2000],
  );
});

test('a duplicated testcase increments attemptIndex and warns', async () => {
  const { attempts, warnings } = await collect(`<testsuite name="s">
    <testcase name="t"><failure message="a">x</failure></testcase>
    <testcase name="t"/>
  </testsuite>`);
  assert.deepEqual(
    attempts.map((a) => [a.attemptIndex, a.status]),
    [
      [0, 'failed'],
      [1, 'passed'],
    ],
  );
  assert.ok(warnings.some((w) => w.code === 'DUPLICATE_TESTCASE'));
});

test('shardIndex is stamped from options, not guessed', async () => {
  const { attempts } = await collect(`<testsuite name="s"><testcase name="t"/></testsuite>`, {
    shardIndex: 3,
  });
  assert.equal(attempts[0]!.shardIndex, 3);
});

// ---------------------------------------------------------------------------
// Hostile input (§4)
// ---------------------------------------------------------------------------

test('rejects XXE: a DOCTYPE with an external entity never resolves', async () => {
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<testsuite name="s"><testcase name="t"><failure message="&xxe;"/></testcase></testsuite>`;
  await assert.rejects(collect(xxe), (e: Error) => {
    assert.match(e.message, /DOCTYPE/);
    assert.equal((e as { code?: string }).code, 'XXE_DOCTYPE');
    return true;
  });
});

test('rejects billion laughs before any expansion happens', async () => {
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<testsuite name="s"><testcase name="&lol3;"/></testsuite>`;
  await assert.rejects(collect(bomb), (e: Error) => {
    assert.equal((e as { code?: string }).code, 'XXE_DOCTYPE');
    return true;
  });
});

test('enforces the nesting depth cap', async () => {
  const depth = 40;
  const xml =
    '<testsuites>' +
    '<testsuite name="s">'.repeat(depth) +
    '<testcase name="t"/>' +
    '</testsuite>'.repeat(depth) +
    '</testsuites>';
  await assert.rejects(collect(xml, { limits: { maxDepth: 8 } }), (e: Error) => {
    assert.equal((e as { code?: string }).code, 'DEPTH_LIMIT');
    return true;
  });
});

test('enforces the attribute-count cap', async () => {
  const attrs = Array.from({ length: 50 }, (_, i) => `a${i}="v"`).join(' ');
  await assert.rejects(
    collect(`<testsuite name="s"><testcase name="t" ${attrs}/></testsuite>`, {
      limits: { maxAttributesPerElement: 10 },
    }),
    (e: Error) => {
      assert.equal((e as { code?: string }).code, 'ATTR_LIMIT');
      return true;
    },
  );
});

test('enforces the byte cap', async () => {
  const padding = 'x'.repeat(5000);
  await assert.rejects(
    collect(
      `<testsuite name="s"><testcase name="t"><failure message="m">${padding}</failure></testcase></testsuite>`,
      { limits: { maxBytes: 1000 } },
    ),
    (e: Error) => {
      assert.equal((e as { code?: string }).code, 'SIZE_LIMIT');
      return true;
    },
  );
});

test('clips an oversized text field and says so rather than growing unbounded', async () => {
  const huge = 'y'.repeat(20_000);
  const { attempts, warnings } = await collect(
    `<testsuite name="s"><testcase name="t"><failure message="m">${huge}</failure></testcase></testsuite>`,
    { limits: { maxTextBytesPerField: 500 } },
  );
  assert.ok(warnings.some((w) => w.code === 'TEXT_TRUNCATED'));
  assert.ok(attempts[0]!.failure!.stackText!.length < 2000);
  assert.match(attempts[0]!.failure!.stackText!, /truncated at 500 bytes/);
});

test('enforces the attempt-count cap', async () => {
  const cases = '<testcase name="t"/>'.repeat(50).replace(/name="t"/g, () => `name="t${Math.random()}"`);
  await assert.rejects(
    collect(`<testsuite name="s">${cases}</testsuite>`, { limits: { maxAttempts: 5 } }),
    (e: Error) => {
      assert.equal((e as { code?: string }).code, 'ATTEMPT_LIMIT');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Malformed and truncated input (§27)
// ---------------------------------------------------------------------------

test('malformed XML fails with a message that names the fix', async () => {
  await assert.rejects(
    collect(`<testsuites><testsuite name="s"><testcase name="t">`),
    (e: Error) => {
      assert.equal((e as { code?: string }).code, 'XML_ERROR');
      assert.match(e.message, /--skip-invalid/);
      assert.match(e.message, /line \d+, column \d+/);
      return true;
    },
  );
});

test('skipInvalid recovers what it can from a truncated file and warns', async () => {
  const { attempts, warnings } = await collect(
    `<testsuites><testsuite name="s">
       <testcase name="finished"><failure message="a">x</failure></testcase>
       <testcase name="cut off">`,
    { skipInvalid: true },
  );
  assert.deepEqual(
    attempts.map((a) => a.displayName),
    ['finished', 'cut off'],
  );
  assert.ok(warnings.some((w) => w.code === 'TRUNCATED_INPUT'));
});

test('an empty suite yields nothing rather than an error', async () => {
  const { attempts } = await collect(`<testsuites></testsuites>`);
  assert.equal(attempts.length, 0);
});

// ---------------------------------------------------------------------------
// Capabilities and detection
// ---------------------------------------------------------------------------

test('capabilities report what the format can carry, not what this file has', () => {
  const c = new JUnitAdapter().capabilities();
  assert.equal(c.structuredAssertion, false);
  assert.equal(c.retries, false);
  assert.equal(c.attemptStartTime, false);
  assert.equal(c.stdout, true);
  assert.equal(c.durations, true);
});

test('detect scores JUnit above ambiguous XML and non-XML at zero', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'crux-detect-'));
  const write = async (name: string, body: string) => {
    const p = join(dir, name);
    await writeFile(p, body);
    return p;
  };
  const adapter = new JUnitAdapter();
  const junit = await write('a.xml', '<?xml version="1.0"?><testsuites><testsuite name="s"><testcase name="t"/></testsuite></testsuites>');
  const otherXml = await write('b.xml', '<?xml version="1.0"?><coverage lines="10"/>');
  const notXml = await write('c.json', '{"suites":[]}');
  assert.ok((await adapter.detect(junit)) >= 0.9);
  assert.equal(await adapter.detect(otherXml), 0.1);
  assert.equal(await adapter.detect(notXml), 0);
  assert.equal(await adapter.detect(join(dir, 'missing.xml')), 0);
  t.diagnostic(`temp dir ${dir}`);
});

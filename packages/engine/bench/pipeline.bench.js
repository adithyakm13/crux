/**
 * Benchmarks for the parse + normalize + fingerprint pipeline (§22).
 *
 * These print measured numbers and nothing else. No target is asserted here as
 * a pass/fail gate except the two §22 rows that are reachable today — parse and
 * fingerprint at 10k and 100k results — because gating on a wall-clock number
 * measured on unknown hardware produces a flaky build, and a flaky build gets
 * deleted. `--json` emits machine-readable output so CI can compare against a
 * stored baseline on its own hardware instead.
 *
 * What is deliberately NOT here: clustering. It does not exist yet (Gate 0 is
 * unmet), so the §22 row that includes it cannot be measured, and reporting a
 * partial figure under that row's name would misstate what was run.
 *
 * Methodology, so the numbers mean something:
 *   - Input is generated once, outside the timed region.
 *   - Each case runs a warmup pass, then N timed repetitions; the median is
 *     reported alongside min and max, because a single sample on a laptop is
 *     dominated by scheduling noise.
 *   - Peak RSS is sampled after each case.
 *   - Hardware and runtime are printed with the results. A benchmark without
 *     its hardware is not a benchmark.
 */
import { cpus, totalmem } from 'node:os';
import { JUnitAdapter } from '@cruxci/adapter-junit';
import { fingerprint } from "../src/fingerprint.js";
import { normalize } from "../src/normalize.js";
/** A synthetic JUnit report with `n` failing testcases across 50 suites. */
function junitReport(n) {
    const parts = ['<?xml version="1.0"?>', '<testsuites>'];
    const perSuite = Math.ceil(n / 50);
    let made = 0;
    for (let s = 0; s < 50 && made < n; s++) {
        parts.push(`<testsuite name="suite ${s}" file="test/s${s}.spec.ts">`);
        for (let i = 0; i < perSuite && made < n; i++, made++) {
            // Varied enough that normalization and fingerprinting do real work, and
            // that fingerprints are not all identical.
            parts.push(`<testcase name="case ${made} does a thing" classname="Suite${s}" time="${(made % 97) / 10}">`, `<failure message="expected ${made % 7} to equal ${made % 11}" type="AssertionError">` +
                `<![CDATA[AssertionError: expected ${made % 7} to equal ${made % 11}\n` +
                `    at check (src/module${s}/thing.ts:${(made % 400) + 1}:${(made % 60) + 1})\n` +
                `    at run (node_modules/mocha/lib/runner.js:12:3)\n` +
                `    at Object.<anonymous> (test/s${s}.spec.ts:${made % 200}:5)\n` +
                `took ${made % 5000}ms; request 550e8400-e29b-41d4-a716-4466554400${String(made % 100).padStart(2, '0')}\n` +
                `connect ECONNREFUSED 10.0.${made % 255}.${(made * 7) % 255}:8080]]>`, '</failure>', '</testcase>');
        }
        parts.push('</testsuite>');
    }
    parts.push('</testsuites>');
    return parts.join('\n');
}
function streamOf(s, chunkSize = 1 << 16) {
    const bytes = new TextEncoder().encode(s);
    let offset = 0;
    return new ReadableStream({
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
async function parseAndFingerprint(xml) {
    let n = 0;
    for await (const a of new JUnitAdapter().parse(streamOf(xml))) {
        if (a.failure === null)
            continue;
        fingerprint({
            errorType: a.failure.errorType,
            message: a.failure.message,
            stackText: a.failure.stackText,
        });
        n++;
    }
    return n;
}
async function measure(c, reps, units) {
    await c.run(); // warmup: first pass pays JIT and regex compilation
    const samples = [];
    for (let i = 0; i < reps; i++) {
        const t0 = performance.now();
        await c.run();
        samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const peakRssMb = process.memoryUsage().rss / 1024 / 1024;
    const r = {
        name: c.name,
        medianMs: median,
        minMs: samples[0],
        maxMs: samples[samples.length - 1],
        reps,
        units,
        perSecond: units / (median / 1000),
        peakRssMb,
    };
    if (c.targetMs !== undefined) {
        r.targetMs = c.targetMs;
        r.withinTarget = median < c.targetMs;
    }
    return r;
}
async function main() {
    const json = process.argv.includes('--json');
    const quick = process.argv.includes('--quick');
    const xml10k = junitReport(10_000);
    const xml100k = quick ? '' : junitReport(100_000);
    const messages = Array.from({ length: 20_000 }, (_, i) => `AssertionError: expected ${i % 13} to equal ${i % 17} after ${i % 900}ms ` +
        `at 10.0.0.${i % 255}:8080 for request 550e8400-e29b-41d4-a716-44665544${String(i % 10000).padStart(4, '0')}`);
    const cases = [
        {
            c: {
                name: 'parse + fingerprint, 10k results',
                targetMs: 5000,
                run: () => parseAndFingerprint(xml10k),
            },
            units: 10_000,
            reps: 5,
        },
        {
            c: {
                name: 'normalize (strict + loose), 20k messages',
                run: () => {
                    for (const m of messages) {
                        normalize(m, 'strict');
                        normalize(m, 'loose');
                    }
                    return messages.length;
                },
            },
            units: 20_000,
            reps: 5,
        },
    ];
    if (!quick) {
        cases.push({
            c: {
                name: 'parse + fingerprint, 100k results',
                targetMs: 30_000,
                run: () => parseAndFingerprint(xml100k),
            },
            units: 100_000,
            reps: 3,
        });
    }
    const results = [];
    for (const { c, units, reps } of cases)
        results.push(await measure(c, reps, units));
    const env = {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        totalMemGb: Math.round(totalmem() / 1024 ** 3),
    };
    if (json) {
        process.stdout.write(JSON.stringify({ env, results }, null, 2) + '\n');
    }
    else {
        process.stdout.write(`crux benchmarks\n` +
            `  ${env.cpu} (${env.cores} cores, ${env.totalMemGb} GB), ` +
            `node ${env.node}, ${env.platform}\n\n`);
        const w = Math.max(...results.map((r) => r.name.length));
        for (const r of results) {
            const target = r.targetMs === undefined
                ? ''
                : `  target <${r.targetMs} ms  ${r.withinTarget ? 'PASS' : 'MISS'}`;
            process.stdout.write(`  ${r.name.padEnd(w)}  ${r.medianMs.toFixed(0).padStart(7)} ms median  ` +
                `(min ${r.minMs.toFixed(0)}, max ${r.maxMs.toFixed(0)}, n=${r.reps})  ` +
                `${Math.round(r.perSecond).toLocaleString('en-US').padStart(10)}/s  ` +
                `rss ${r.peakRssMb.toFixed(0)} MB${target}\n`);
        }
        process.stdout.write(`\nNot measured: clustering. It does not exist yet (Gate 0 unmet), so the\n` +
            `§22 rows that include it cannot be reported.\n`);
    }
    // Exit non-zero only on a stated §22 target that this case fully covers.
    return results.some((r) => r.withinTarget === false) ? 1 : 0;
}
process.exitCode = await main();
//# sourceMappingURL=pipeline.bench.js.map
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
export {};
//# sourceMappingURL=pipeline.bench.d.ts.map
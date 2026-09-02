# Benchmarks

Every number here is produced by `pnpm bench`. Nothing is typed in by hand.
Rerun it and you get your own hardware's numbers; these are one machine's.

```bash
pnpm bench            # full, including the 100k case
pnpm bench --quick    # skips the 100k case
pnpm bench --json     # machine-readable, for a regression baseline
```

## Hardware and runtime

| | |
|---|---|
| CPU | Apple M4 |
| Cores | 10 |
| Memory | 16 GB |
| Platform | darwin-arm64 |
| Node | v25.1.0 |

A benchmark without its hardware is not a benchmark, which is why this is
printed with the results rather than described in prose.

## Results

| Workload | Median | Min / max | Reps | Throughput | Peak RSS | §22 target | |
|---|---|---|---|---|---|---|---|
| parse + fingerprint, 10k results | 270 ms | 269 / 276 ms | 5 | 37,072/s | 470 MB | < 5 s | PASS |
| normalize (strict + loose), 20k messages | 263 ms | 262 / 280 ms | 5 | 76,106/s | 473 MB | — | — |
| parse + fingerprint, 100k results | 2693 ms | 2692 / 2708 ms | 3 | 37,137/s | 556 MB | < 30 s | PASS |

Throughput is flat from 10k to 100k results, which is the point worth checking:
it is what confirms the JUnit path actually streams rather than accumulating.

## Methodology

- Input is generated once, outside the timed region.
- Each case runs a warmup pass first, so the measurement excludes JIT and regex
  compilation.
- The median of N repetitions is reported, with min and max. A single sample is
  dominated by scheduling noise.
- Peak RSS is sampled from the process after each case, so it is cumulative
  across cases within one run — treat it as an upper bound, not a per-case
  figure.

## What is deliberately not measured

**Clustering.** It does not exist: Gate 0 is unmet, and Phase 1 does not start
until it is met or reported as failed. The §22 rows that read "parse +
fingerprint + cluster" therefore cannot be reported, and the rows above are
named for what actually ran. Reporting a partial pipeline under the full row's
name would misstate the result.

**Storage, historical queries, flake computation.** Phase 3. No storage layer
exists yet.

**The signal ablation table** §8 requires. It needs labelled clustering ground
truth to score against, and the corpus is unlabelled. The mechanism is built —
every normalization rule is individually toggleable via
`normalize(text, mode, { disabled: [...] })` — so the table can be produced as
soon as there is something to measure it against.

## Gating

CI runs `pnpm bench` on every push. The process exits non-zero only when a case
with a **stated §22 target** misses it. Wall-clock time is not otherwise gated:
a threshold tuned to one runner's hardware produces a flaky build, and a flaky
build gets removed from the pipeline. The `--json` output is uploaded as an
artifact so a per-runner regression baseline can accumulate over time instead.

# crux

**crux ci** turns raw test results into engineering decisions.

A developer opens CI. 22 tests are red. Today they spend 40 minutes discovering
it was one broken payment endpoint. crux is being built to tell them in four
seconds: 18 failures share one cause, 3 share another, 1 is unrelated — and for
each, the evidence.

A test failure is not a bug. crux exists to separate the cases:

| Class | Means | Action |
|---|---|---|
| `PRODUCT_REGRESSION` | Code under test broke | Fix the product |
| `TEST_DEFECT` | Test is wrong | Fix the test |
| `FLAKY` | Nondeterministic | Quarantine, then fix |
| `ENVIRONMENT_FAILURE` | Infrastructure broke | Fix CI, retry |
| `DEPENDENCY_FAILURE` | External service broke | Retry or stub |
| `DATA_FAILURE` | Fixture or state wrong | Fix data setup |
| `PERFORMANCE_REGRESSION` | Slower, not wrong | Investigate perf |
| `UNKNOWN` | Insufficient evidence | Say so |

`UNKNOWN` is a first-class answer. A system that guesses to avoid saying
`UNKNOWN` is worse than no system, because users calibrate on early wrong
answers and never come back.

---

## Status: Gate 0, in progress

crux is at **Gate 0 — ground truth**. No product CLI exists yet, and that is
deliberate. Every claim crux will make is a classification claim, and without
labelled data none of them are falsifiable.

What exists today:

- **`@cruxci/core`** — framework-neutral domain model, independent version
  lines, and the statistics every gate is evaluated with (Wilson intervals,
  bootstrap over runs, pairwise F1, Cohen's kappa).
- **`@cruxci/adapter-junit`** — hardened streaming JUnit XML parser. Rejects
  DOCTYPE outright, caps bytes, depth, attributes, field size and attempt count.
- **`@cruxci/adapter-playwright`** — Playwright JSON reporter and blob report.
- **`@cruxci/engine`** — normalization (§5), frame classification and
  fingerprinting (§6), MinHash and LSH banding.
- **`@cruxci/corpus-tools`** — corpus harvester, labelling tool, Gate 0 status,
  agreement, separability and the baseline spike.

What does not exist: clustering, classification, the `crux` CLI, storage,
history, flakiness, risk, selection, the dashboard, and AI. Those are Phase 1
and later, and Phase 1 does not begin until Gate 0 is met or is reported as
failed.

**No example output appears in this README.** Nothing will be shown here until
the tool produces it on a real run.

### Where Gate 0 stands

Run it yourself; the command reports the state without interpretation:

```bash
pnpm corpus status
```

The two requirements tooling cannot satisfy are named explicitly in that
output. Both need people:

- **Inter-labeler agreement** — two people label the same 100-failure subset
  independently. Below 0.80 pairwise agreement, the task is ambiguous as
  specified and every downstream target needs revisiting.
- **Separability** — one labeller sees only the failure payload, with no
  repository, git or run context; agreement with the full-context label over
  150 failures *is* the separability rate. If its Wilson upper bound is below
  60%, the payload-only thesis is wrong, and crux stops.

## Privacy

**No telemetry. Not opt-out, not anonymous, none.** This is a permanent product
commitment.

Everything works air-gapped except AI and the GitHub integration.
Fingerprinting, clustering, classification, flakiness, risk and selection are
all offline by construction. AI is off by default and will require explicit
configuration to turn on.

## Development

Requires Node 20+ and pnpm 10+. Node 25 no longer ships corepack, so install
pnpm directly:

```bash
npm i -g pnpm@10
```

Then:

```bash
pnpm install
pnpm build
pnpm test
```

### Building the corpus

Harvesting needs the GitHub CLI, authenticated:

```bash
gh auth login
```

```bash
pnpm corpus harvest --repos corpus/sources.txt --runs-per-repo 25
```

Artifact retention on most active repositories is one to a few days, so a single
pass only ever reaches recent runs. Harvest is idempotent on run id — run it
repeatedly over time and the corpus accumulates.

```bash
pnpm corpus label --labeler your-name
```

The labelling tool never shows crux's own prediction. A labeller who sees the
model's guess anchors on it, and the resulting score measures agreement with the
model rather than with the truth.

## Documentation

- [`docs/evidence.md`](docs/evidence.md) — the Gate 0 argument and its current state
- [`docs/limitations.md`](docs/limitations.md) — what crux does not do correctly yet
- [`SECURITY.md`](SECURITY.md) — disclosure process

## Licence

Apache-2.0. The patent grant matters for the enterprise adoption this targets.

crux is **fully open**, not open-core. There is no paid tier holding back
features described in the specification.

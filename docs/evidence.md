# Evidence — Gate 0

This document is the argument that crux is worth building, and the record of
whether the measurements support it. It is written to be falsifiable.

**Status: incomplete.** The corpus exists and is growing; no labels exist yet.
The separability rate, the inter-labeler agreement and the baseline spike are
all stated below as procedures with no numbers attached, because producing a
number before the measurement has been made is the specific failure this
document exists to prevent.

Nothing in this file is estimated, extrapolated or assumed. Where a number is
missing, it is missing.

---

## 1. The separability rate

**Not yet measured.**

### Definition

A second labeller sees *only the failure payload* — message, stack, stdout,
timing, exit code. No repository, no git, no logs, no run context. They assign a
category. Agreement with the full-context label, over a 150-failure sample, **is**
the separability rate.

The tooling enforces the condition rather than trusting the labeller to
self-police: in `payload-only` mode, `corpus label` withholds the repository,
workflow, branch, commit and run URL from the header it renders. `corpus
separability` refuses to score a labeller whose stored context is not
`payload-only`, because scoring full-context labels as payload-only would
fabricate the number.

### How to produce it

```bash
corpus label --labeler alice --context full
corpus label --labeler bob --context payload-only
corpus separability --full alice --payload bob
```

### Stop condition

If the Wilson **upper** bound is below 60%, the payload-only thesis is wrong.
Report it and stop. Do not build around a negative result.

`corpus separability` prints this verdict itself; it is not left to
interpretation.

---

## 2. Why not ReportPortal

ReportPortal has done open-source clustering and machine-learning failure
classification for roughly eight years, and has roughly 1.4k GitHub stars. Any
honest case for crux has to answer why that is, and the answer cannot be "we
will do it better".

The distinctions crux is betting on, stated so they can be judged and, if
wrong, abandoned:

**Adoption cost.** ReportPortal is a server: a deployment, a database, an
account, and results pushed to it before anything can be analysed. crux's
single-run path is a binary reading a JUnit file on a laptop with no account and
no network. That is the wedge; if the offline single-run path does not stand on
its own, crux has no advantage worth having.

**What is asserted versus what is measured.** crux's clustering quality is
defined as pairwise F1 against human labels, with a bootstrap interval over
runs, published with an ablation table. That discipline is the product claim as
much as the clustering is. It also means the thesis can be falsified by its own
tooling — which §1 above is designed to do.

**Honest abstention.** `UNKNOWN` is a first-class output, and `FLAKY` is
unreachable without history rather than guessed from one run. A tool that
guesses to look decisive trains its users to distrust it.

**These are hypotheses, not findings.** None of them is evidence. The evidence
is the separability rate in §1 and the clustering F1 in §4.

---

## 3. What fraction of failures need information the results do not contain

**Not yet measured.**

This is the honest ceiling of payload-only analysis, and it is the argument for
the observability integration in Phase 6. It is measured from the full-context
labelling pass: for each failure, the labeller records whether the payload alone
was sufficient, or whether they needed logs, traces, deploy events or the diff.

A first structural observation, from harvesting rather than labelling: of the
runs examined so far, a large majority could not be harvested at all because
their artifacts had already expired (see §5). That is a data-availability
ceiling, not an analysis ceiling, but it bounds how fast this number can be
produced.

---

## 4. The baseline spike

**Not yet measured.** The tooling is implemented and runs; it has no labels to
score against.

### Definition

Label 50 failures from 8 multi-failure runs. Cluster them with the crudest
possible rule — exact loose-fingerprint match, no graph, no weights. Measure
pairwise F1.

```bash
corpus baseline --labeler alice
```

`naiveLooseFingerprintGroups` is exactly that rule: two failures are the same
cause when their loose fingerprints are byte-identical. Nothing else.

### How the result is to be read

| Naive F1 | Conclusion |
|---|---|
| near 0.75 | The weighted graph in §8 is over-engineering. Ship the simple thing. |
| near 0.30 | The problem is genuinely hard, and we know it before investing in the full corpus. |
| near 0.05 | The payload does not carry the signal. Stop and reconsider before Gate 0. |

This costs two days and is the highest-information move in the project. It is
sequenced deliberately *before* the 1000-label investment.

---

## 5. Corpus construction: what actually happened

The corpus is sourced from public GitHub Actions runs that upload test artifacts
(source 2 in the specification's ranking). Two findings from the first harvest
change the plan, and both are worth recording.

### Artifact retention is the binding constraint

Across the candidate repositories examined, **20 to 22 of every 25 failed runs
had already expired**. Most active repositories keep Actions artifacts for one
to a few days. A single harvesting pass can therefore only ever reach a recent
window, regardless of how many repositories are in the list.

Consequence: reaching the Gate 0 run count is a scheduled, repeated operation
rather than a one-off. `corpus harvest` is idempotent on `corpusRunId`, so
repeated runs accumulate instead of duplicating.

### Most artifacts that look like test results are not machine-readable

Repositories that upload "test results" frequently upload an HTML report, a
screenshot bundle, or a custom summary. The harvester dispatches on file
contents rather than on filename, and discards what no adapter can read; the
count of rejected files is recorded per corpus run.

Supporting the Playwright blob report specifically was the single change that
made the largest number of live artifacts reachable, because it is what
Playwright-based CI actually uploads.

### The deepest-app-frame signal is available on 12% of failures so far

§6 calls the deepest `app` frame "the single most stable and most causally
meaningful signal in a stack trace", and §8 gives "shared deepest app frame" a
weight of 0.60. Measured over the corpus at 16 runs / 74 failures — a snapshot,
since the corpus is still growing:

| Framework | Failures | With an app frame | Rate (Wilson 95%) |
|---|---|---|---|
| playwright | 55 | 0 | 0.000 [0.000, 0.065] |
| pytest | 9 | 5 | 0.556 [0.267, 0.811] |
| unidentified | 5 | 0 | 0.000 [0.000, 0.434] |
| vitest | 3 | 2 | 0.667 [0.208, 0.939] |
| junit-jvm | 2 | 2 | 1.000 [0.342, 1.000] |
| **total** | **74** | **9** | **0.122 [0.065, 0.215]** |

Every failure parsed at least one frame; the column that varies is whether any
of them is application code.

The split is the finding, not the total. Playwright E2E failures have **no** app
frame at all — the stack's only frame is the spec file, which classifies as
`test`, because the failure happened inside Playwright's own machinery acting on
behalf of test code. Unit-test frameworks are the opposite: pytest, vitest and
JVM stacks supply an app frame more often than not.

So §8's 0.60 weight on a shared deepest app frame is not wrong, but it is
**unavailable for exactly the workload that produces the most failures per run**.
Any clustering evaluation must report per-framework F1, or an aggregate number
will be dominated by the E2E case where the signal is missing entirely and will
say nothing about the case where it is present.

Two corrections to an earlier draft of this section, recorded because the
mistakes are instructive:

- It claimed the signal was absent from *every* failure. That was true of the
  corpus at the time, but the cause was partly a missing parser, not the data.
  Vitest emits frames marked with a heavy arrow rather than `at `, so crux
  parsed zero frames from them and discarded a real app frame.
- The framework count briefly read three by counting `junit` as a framework.
  JUnit XML is a *format* emitted by pytest, jest, vitest, surefire and others.
  Counting it inflated the Gate 0 framework count with a name that identifies
  nothing. Only an adapter whose name genuinely identifies a framework — the
  Playwright blob report, which nothing else emits — now counts as evidence,
  and the unidentified remainder is reported alongside rather than folded in.

`fingerprint()` reports `usedFrameFallback` rather than silently hashing
whatever frames it found, so the prevalence of this case stays measurable.

### Licence handling

GitHub reports `NOASSERTION` for a `LICENSE` file it cannot classify, which is
not the same as a repository having no licence. crux records both the raw answer
and the resolved SPDX id, reports the two cases separately, and skips both by
default. Several of the richest JUnit XML sources found so far fall into the
`NOASSERTION` bucket and are excluded pending human review.

---

## 6. How every number in this document will be evaluated

- Point estimates alone are not gate evidence. Every metric carries a 95%
  interval — Wilson for proportions, bootstrap over **runs** for clustering.
- Bootstrap resamples runs, never pairs. Pairs within a run are strongly
  correlated; treating them as independent produces intervals several times too
  narrow, which turns a failing gate into a passing-looking number.
- A gate passes when the **lower** bound clears the threshold. A point estimate
  of 0.82 with a lower bound of 0.68 has not passed a 0.80 gate.
- Held out means held out from the start. No threshold is tuned on data it is
  later evaluated on.

These rules are implemented in `@cruxci/core`'s `stats.ts` — `wilson`,
`bootstrapPairF1`, `gatePasses`, `cohensKappa`, `pairwiseAgreement` — so that
they are applied by construction rather than by remembering to.

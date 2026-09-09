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

### The deepest-app-frame signal splits sharply by framework

§6 calls the deepest `app` frame "the single most stable and most causally
meaningful signal in a stack trace", and §8 gives "shared deepest app frame" a
weight of 0.60. Measured over the committed corpus:

| Framework | Failures | With an app frame | Repos | Rate (Wilson 95%) |
|---|---|---|---|---|
| jest | 1059 | 12 | 2* | 0.011 [0.006, 0.020] |
| unidentified | 602 | 27 | 5* | 0.045 [0.031, 0.064] |
| playwright | 164 | 35 | 6 | 0.213 [0.158, 0.282] |
| junit-jvm | 134 | 95 | 4 | 0.709 [0.627, 0.779] |
| pytest | 108 | 40 | 6 | 0.370 [0.285, 0.464] |
| vitest | 34 | 16 | 2 | 0.471 [0.315, 0.633] |
| go-test | 5 | 0 | **1** | 0.000 [0.000, 0.434] |
| **total** | **2106** | **225** | **20** | **0.107 [0.094, 0.121]** |

A **bold** repository count means the row is one repository, and `*` means one repository supplies over 80% of it. Such a row is a claim about those repositories, not about the framework.

Measured over 108 committed run(s) across 20 repositories (corpus `d0add43ea35a`). Regenerate with `pnpm corpus frames --markdown`.

**The split is by repository at least as much as by framework, and that took a
second repository to see.** jest read 0 of 1029 across every measurement until a
second jest project entered the corpus and returned 12 of 30 — 0.400
[0.246, 0.577], an interval that does not overlap the first:

| Repository | jest failures | With an app frame |
|---|---|---|
| opennextjs/opennextjs-netlify | 1029 | 0.000 [0.000, 0.004] |
| druxt/druxt.js | 30 | 0.400 [0.246, 0.577] |

Same framework, opposite results. Next.js's e2e harness wraps every frame in its
own machinery, so nothing application-level survives; ordinary jest unit tests
keep their call chain. "jest has no app frames" was a claim about one project.

`corpus frames` now reports a repository count per row and flags any row that is
one repository, or that one repository supplies more than 80% of. Three of the
seven rows are currently flagged. A flagged row is a claim about those
repositories, not about the framework — this is the third time in this project
that a single-repository sample produced a confident wrong conclusion, so it is
now surfaced by the tool rather than left to whoever reads the table.

What survives the correction:

The split is the finding, not the total. Two framework families sit at opposite
ends, and the reason is structural rather than incidental:

- **End-to-end suites lose the signal.** Playwright gives 0.213 and Next.js's
  jest e2e harness gives 0 of 1029: the only frame is the spec file, which
  classifies as `test`, because the failure happened inside the framework's own
  machinery acting on behalf of test code.
- **Unit suites keep it.** junit-jvm 0.709, vitest 0.471, jest-in-druxt 0.400,
  pytest 0.370. JVM, Node and Python stacks carry the application call chain.

So the axis is closer to *end-to-end versus unit* than to any particular
framework, and no row should be read as a property of a framework until several
repositories contribute to it.

So §8's 0.60 weight is not wrong, but it is **unavailable for a large share of
real CI failures**, and which share depends entirely on the framework mix.
Clustering evaluation must therefore report per-framework F1; an aggregate would
be dominated by whichever family happens to be over-represented.

#### 29% of failures still have no identifiable framework

`unidentified` is 602 of 2076 failures. It was 1137 until the detector stopped
racing substrings over one concatenated haystack and started matching frame
shapes: requiring `org.junit` missed JVM stacks whose runner frames surefire had
trimmed, and requiring the literal word `jest` missed hundreds of unmistakable
jest failures whose harness never prints it. That reclassified 535 failures and
regressed none — verified by diffing every failure's label across the whole
corpus, not by spot checks.

The remainder is a real limitation, not a rounding error — see
docs/limitations.md.

#### This table is generated, and earlier hand-written versions were wrong

`corpus frames` emits it from the committed corpus, stamped with a digest of the
exact run set. Three corrections worth keeping, because each was a different
mistake:

1. An early revision published 9/74 = 0.122 [0.065, 0.215], typed in by hand. It
   was measured over a working tree that included runs the repository refuses to
   ship, so it was not reproducible from a clone even in principle.
2. The corrected figure, 25/87 = 0.287 [0.203, 0.390], was reproducible but
   **badly sampled**. At 4x the data it moved to 0.103 [0.090, 0.116] — outside
   its own interval. A Wilson interval quantifies sampling noise at a fixed
   sample; it says nothing about a sample drawn from three repositories rather
   than nineteen. The lesson is that interval width is necessary and not
   sufficient: representativeness is a separate question, and the honest guard
   is to report the run and repository count alongside every figure, which the
   command now does.
3. The pytest row moved from 0.920 [0.750, 0.978] to 0.376 [0.291, 0.470] for
   the same reason — the earlier 25 failures came mostly from one project.

`fingerprint()` reports `usedFrameFallback` rather than silently hashing
whatever frames it found, so the prevalence of this case stays measurable.

### The machine labels survived an adversarial audit built to catch one bias

The 125 machine labels underpinning the pipeline probe were produced by a model
and then reviewed twice by the same model. Across those reviews it made four
corrections and **every one was a merge** — it never once found an over-merge. A
reviewer that only ever merges eventually puts everything in one group, and it
cannot audit that in itself, because it re-reads its own reasoning and agrees.

So the labels were attacked from both directions by independent agents: sixteen
tasked with splitting one group each, three lenses hunting cross-group merges
(shared infrastructure, wrapper-and-wrapped, upstream-downstream), and a skeptic
refuting every proposal.

**Result: one proposal from nineteen attackers, and it was refuted.** Nothing
changed.

The single proposal argued that `sdxl-lora-accuracy` should split, on the
grounds that one failure's degradation was resolution-conditioned while the rest
were resolution-invariant. The skeptic falsified that from the parametrize list
quoted in the failures' own stacks: of four `test_crossattndown` parameter
combinations, three failed and the fourth is absent from the run, and the two
that differ *only* in image resolution land on opposite sides — one fails at
0.5315, the other passes. Resolution-conditioning is a property the retained
group already exhibits, so it cannot be the discriminator that separates
anything from it. Every PCC value the skeptic quoted was checked against the
payload and matches.

Two caveats keep this from being stronger than it is:

- The attackers share a model family with the labeller, so correlated blind
  spots are not excluded. This raises confidence; it does not substitute for a
  second human.
- Eighteen agents returning nothing is consistent with solid groupings and also
  with attacking being harder than defending. Each was verified to have read
  both the labels and the raw payloads — 8 to 49 tool calls apiece — so the
  empty results are reasoned rather than idle, but that is the limit of what can
  be claimed.

What it does establish: the probe's headline — precision 0.981 against recall
0.677 — does not rest on groupings that fall over when pushed.

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

# Limitations

Every entry here is something crux does not do correctly yet. Each names the
safe fallback that runs instead, so nothing in this list is a silent failure.

This file is maintained under the rule in §30 of the specification: if something
cannot be implemented correctly yet, document the limitation, provide a safe
fallback, and add a roadmap entry — never pretend.

## Ingestion

### Playwright JSON reports are parsed whole, not streamed

`@cruxci/adapter-playwright` streams the blob report (`report.jsonl`) line by
line, but the JSON reporter emits one document and crux has no incremental JSON
parser. That path is capped at 256 MiB (`MAX_MONOLITHIC_JSON_BYTES`) and fails
above it with an error naming the blob reporter as the alternative.

**Fallback:** explicit `SIZE_LIMIT` error, never an out-of-memory crash.
**Roadmap:** an incremental JSON reader, or a Rust port if a benchmark shows the
parse is CPU-bound rather than IO-bound (§16).

### JUnit XML input is stripped of ANSI and control characters before parsing

ESC (U+001B) is not a legal XML 1.0 character, in raw form or as `&#27;`, yet
Playwright, pytest and several Maven reporters write it into JUnit XML anyway.
A strict parser rejects those files outright. crux removes whole ANSI escape
sequences and XML-illegal control characters from the byte stream first.

This loses nothing analysis uses — normalization (§5) strips ANSI in any case —
but it is a lossy step, so it is counted and reported as a
`CONTROL_CHARS_STRIPPED` warning rather than performed silently.

### JUnit XML cannot express retries, so absence of retries means nothing

`capabilities().retries` is `false` for JUnit. Surefire's `rerunFailure` and
`flakyFailure` elements *are* parsed into separate attempts when present, but a
producer that cannot emit them looks identical to a run where no retry happened.
Downstream analysis must treat the absence of retries in JUnit as uninformative,
not as evidence.

### Duplicate testcases in one JUnit file are treated as retries

A `<testcase>` with the same name appearing twice in one file is recorded as
attempt 0 and attempt 1, with a `DUPLICATE_TESTCASE` warning. This is genuinely
ambiguous: some producers mean a retry, others mean two parameterized cases that
share a label. crux preserves both rather than collapsing them, because §3 makes
the attempt the grain, but the interpretation may be wrong.

### Shard index in harvested corpus runs is the artifact's position

The GitHub API does not report which shard produced an artifact. The corpus
harvester numbers artifacts by their order within the run. That is enough to say
"these records came from different uploads" and nothing more; it does not
identify a machine, and no clock-skew correction is derived from it.

## Analysis

### `FLAKY`, `PRODUCT_REGRESSION` and `PERFORMANCE_REGRESSION` are unreachable in Phase 1

They require history: an outcome sequence, a parent-commit result, and a
duration baseline respectively. In single-run mode crux emits `UNKNOWN` with the
missing evidence named. Emitting `FLAKY` from one run is a guess dressed as an
analysis (§9).

### The generated-identity rule is narrower than "any email"

The §5 table says "generated emails". crux normalizes email addresses whose
local part carries a counter or a random blob, plus the reserved test domains
(`example`, `test`, `invalid`, `localhost`, `mailinator`, `faker`). A plain
`alice@corp.io` in an assertion is left alone, because in an assertion it is
usually signal rather than noise. The rule is `generated-email` and can be
switched off in the ablation table if that judgement turns out to be wrong.

### Epoch timestamps are recognised only in a plausible range

`epoch-ms` and `epoch-s` match 13- and 10-digit integers beginning with `1`,
which covers 2001 to 2033. An unbounded `\d{10,13}` would swallow ordinary large
integers, which are frequently the value an assertion is about. Timestamps
outside that range survive normalization unchanged.

### Frame ordering is inferred per dialect

Python prints tracebacks outermost-first; V8, the JVM, Go and Ruby print
innermost-first. crux reverses a stack when at least half its parsed frames came
from the Python parser. A stack that mixes dialects in some other proportion may
be ordered wrongly, which would make `deepestAppFrame` pick the wrong frame.

### Stacks with no application frame fall back to the deepest frames of any kind

When frame classification finds nothing owned by the repository, the fingerprint
hashes the deepest frames whatever their kind, and the result carries
`usedFrameFallback: true`. This keeps distinct framework failures
distinguishable; it does not make them causally meaningful.

This is not a rare edge case. Measured over the corpus at 16 runs / 74
failures, an app frame is present on 9 of 74 — 0.122 [0.065, 0.215] — and on
**none** of the 55 Playwright E2E failures, whose only frame is the spec file.
pytest, vitest and JVM stacks supply one more often than not. See
`docs/evidence.md` for what that implies about the 0.60 weight §8 assigns to the
shared-deepest-app-frame signal, and why clustering results must be reported per
framework.

## Corpus and Gate 0

### GitHub Actions artifact retention bounds what can be harvested in one pass

Most active repositories keep artifacts for one to a few days. In the first
harvest across 26 candidate repositories, 20 to 22 of every 25 examined failed
runs had already expired. Reaching the Gate 0 run count therefore requires
harvesting repeatedly over time, not once. `corpus harvest` is idempotent on
`corpusRunId`, so repeated runs accumulate rather than duplicate.

**Roadmap:** a scheduled harvest, so the corpus grows daily instead of in one
sitting.

### Repositories whose licence GitHub cannot identify are skipped by default

GitHub reports `NOASSERTION` for a `LICENSE` file it cannot classify — commonly
a mixed or custom licence. crux distinguishes that from a repository with no
licence at all and reports them separately, but skips both unless
`--allow-unlicensed` is passed. This excludes some of the richest sources of
JUnit XML found so far.

### The corpus cannot be labelled by tooling

Grouping and category labels come from humans. `corpus label` exists to collect
them and deliberately never shows crux's own prediction, because a labeller who
sees the model's answer anchors on it and the resulting F1 measures agreement
with the model rather than with the truth.

## Neither Playwright path streams

`@cruxci/adapter-playwright` materialises the whole input before parsing, for
both the JSON reporter and the blob report.

The JSON reporter emits one document and crux has no incremental JSON parser.
The blob report is line-delimited and looks streamable, but its suite tree
arrives before the results and attachments arrive as separate events, sometimes
after the test they belong to, so a single forward pass cannot assemble an
attempt.

**Safe fallback:** both paths are bounded by an explicit size cap and fail with
a `SIZE_LIMIT` error naming the blob reporter and this file, rather than
exhausting memory. The JUnit adapter does stream.

**Roadmap:** an incremental JSON parser, or a two-pass blob reader that indexes
offsets rather than holding text.

## A stray unterminated ANSI OSC sequence can make a JUnit file unparseable

The XML sanitizer consumes the body of an unterminated `ESC ]` sequence rather
than leaving it in the byte stream. If that body contains the enclosing `]]>`,
the CDATA section is no longer closed and the file fails to parse.

This is deliberate. Leaving the body is worse: it is attacker-chosen text that
reaches the XML parser as markup, and a body carrying `]]>` followed by
`<testcase>` elements writes tests that never ran into the corpus — poisoning
every Gate 0 number computed from it. A stream-level sanitizer cannot both
preserve XML structure and neutralise arbitrary text after a stray ESC.

**Safe fallback:** a loud `XML_ERROR` naming the file and position, recoverable
with `--skip-invalid`, instead of silent fabrication.

## Normalization runs its rule cascade to a fixed point

Individually idempotent rules do not compose into an idempotent cascade: one
rule's output can create a match for a rule that already ran. Rather than
depending on a rule ordering that holds today and breaks when a rule is added,
`normalize` iterates the cascade until the output stops changing, capped at
`MAX_NORMALIZE_PASSES`.

**Cost:** normalization does at least two passes over every message, since the
second pass is what confirms convergence.

**Safe fallback:** if the cap is reached without converging, the last iterate is
returned — normalization stays total and never throws. A property test over
generated input asserts that branch is unreachable for anything it can produce.

## Framework detection fails on most failures

`detectFramework` attributes a producing framework from payload evidence only —
a stack-frame marker, a path shape, an error type. On the committed corpus it
cannot attribute 602 of 2076 failures (29%), which arrive as JUnit XML from
producers that leave no distinguishing tell.

It was 55% until the detector was rewritten to match frame *shapes* before
lexical tokens. Two rules were wrong in the same way — they demanded a name the
producer does not always print. JVM required `org.junit`, which surefire trims;
jest required the literal word `jest`, which Next.js's harness never emits. A
word appearing anywhere is weak evidence in any case: a test *named* "playwright
migration" is not a Playwright failure.

**Why it is not guessed:** JUnit XML is emitted by pytest, jest, vitest,
surefire, karma and a dozen others. Attributing on filename or adapter name
would inflate the Gate 0 framework count with a label that identifies nothing,
which it briefly did.

**Safe fallback:** they are counted as `unidentified` and reported as their own
row rather than folded into a framework, so the size of the gap is visible in
every table.

**Roadmap:** more producer tells (surefire's `<properties>`, jest's exact frame
shape), and a `producerHint` field the harvester can populate from the artifact
name when the artifact is unambiguous.

## The corpus is heavily concentrated

At 104 committed runs the top three repositories supply most of the failures,
the median run has 2 failures, and several runs carry over 200 — a whole suite
collapsing, not hundreds of distinct root causes.

This matters more than it looks because the clustering metric is pair-based: a
run of n failures contributes n(n-1)/2 pairs, so one 600-failure run outweighs a
6-failure run by four orders of magnitude in any pooled score.

**Safe fallback:** `corpus status` reports the concentration figures and warns
when the top three repositories exceed half the corpus or any run exceeds 200
failures. `corpus label --max-failures N` skips the collapses so a labeller can
work the tractable runs. Bootstrap intervals resample runs, which limits how far
one run can move an interval — but not how far it moves the point estimate.

**The sampling policy now exists.** `corpus sample` chooses the labelled subset
under a written-down, seeded, reproducible policy: exclude suite collapses and
single-failure runs, cap runs per repository, and fill framework strata
round-robin so no family dominates. It reports the sample's framework mix
against the corpus's, and declares any framework that is a material share of the
corpus but missing from the sample — currently jest, at 25% of corpus failures
and 0% of the sample, because no run of 5-40 failures is dominated by it.

**Per-framework and per-repository F1 now exist** in `corpus baseline`. A pair
belongs to a framework only when both of its failures do — the only definition
that does not invent an answer for a cross-family pair — and the pairs that span
two frameworks are counted in the aggregate and reported separately, so the rows
need not sum to the total and the reader is told why.

**Still open:** the same stratification for the clustering scores, once
clustering exists.

## Targeted harvesting for a specific framework has near-zero yield

Closing the jest and Playwright gap by harvesting was tried and mostly failed. A
code search built a pool of 771 candidate repositories using jest and Playwright
reporters; filtering for recent activity and a live test-like artifact left 27;
harvesting 11 of those produced **4 usable runs from 1 repository**.

Two causes, one of them a mistake in the scan rather than in the world:

- The scan filtered on artifact *names* matching `report|junit|jest|test-result`,
  while the harvester dispatches on file *contents*. A repository uploading
  `playwright-report/` containing only HTML passes the scan and yields nothing.
  A parseability check belongs in the scan.
- The rest is retention and green runs: `all artifacts expired`, and
  `no failures in run` — artifacts parsed fine, the run simply passed.

**What this justifies:** within-run slicing was the right way to reach a
framework trapped in suite collapses, not a workaround for insufficient
harvesting. The 4 runs that did land were worth it — they were the second jest
repository, which is what revealed that jest's 0-of-1029 app-frame rate was a
property of one project's harness rather than of jest.

**Fixed.** `corpus scan` now answers the question the harvest will ask, rather
than approximating it: it downloads the smallest candidate artifacts, unzips
them under the same guards, and runs the harvester's own `pickAdapter` and
parser. A repository counts as productive only when something actually parses to
a failure. Both commands call the same two functions, so they cannot diverge
again.

Two calibration details, both learned by checking against a repository whose
yield was already known:

- The probe's depth defaults to the harvest's depth. druxt/druxt.js is
  productive at 25 runs and looks dead at 10, because its four productive runs
  are older than its ten most recent failures. A shallower probe answers a
  different question.
- The download budget is per run, not per repository. A repository-wide cap is
  exhausted by the newest runs, which are often the least interesting.

**The correct scan is expensive, and that is the trade.** Measured over three
repositories at default depth: 33.5 MB across 54 artifacts, one verdict per
~11 MB. The old name-only scan was nearly free and wrong; this one is right and
costs real bandwidth and minutes. Probing a 771-repository code-search pool this
way would run to gigabytes and hours.

**So use it as the second stage, not the first.** Shortlist cheaply — code
search, stars, recent activity, a live artifact whose *name* looks plausible —
then probe only the shortlist, and only then harvest. The name filter is a fine
way to decide what to probe. It was only wrong as a way to decide what is
productive.

`--runs` and `--downloads` trade depth for speed, but lowering them below the
harvest's depth reintroduces exactly the disagreement this command exists to
remove: druxt/druxt.js is productive at 25 runs and looks dead at 10.

### "Payload-only" withholds metadata, not identity

The sealed worksheet withholds repository, workflow, branch, commit, and — since
the entries are shuffled with a seed derived from the selection — which failures
came from the same CI run. Run adjacency is provenance: twenty-four consecutive
entries announce "one CI run" as loudly as a repository name would, and that is
a grouping hint separability is supposed to withhold.

What it cannot withhold is the failure text. Stack frames carry checkout paths
(`/home/runner/work/<repo>/<repo>/...`) and test names carry product nouns. On
the current spike sample, **91 of 156 entries (58%) name their own repository
somewhere in the payload**, concentrated entirely in four of the six
repositories:

```
 20/20   trinodb/trino
 24/24   Sage/carbon
 23/23   druxt/druxt.js
 24/24   opennextjs/opennextjs-netlify
  0/20   tenstorrent/tt-metal
  0/45   GoogleCloudPlatform/DataflowTemplates
```

This is not scrubbed, and should not be. The payload is what crux will actually
show a user; a payload edited to hide its own origin would make the separability
number a measurement of an input nobody will ever see.

The consequence is a limit on interpretation. A separability rate from this
sample answers "can a labeller judge from the payload the tool displays" — it
does **not** answer "can a labeller judge without knowing which project this
is". The sealed page states the count on its own protocol panel rather than
leaving the distinction to this document.

`provenanceInPayload()` in `corpus-tools` computes it, counting owner and
repository name as case-insensitive substrings of the whole payload. That is
deliberately loose: it is an upper bound on what the labeller could recognise,
and over-counting is the safe direction.

### The spike sample is sized in failures; the bootstrap resamples runs

The Gate 0 spike selects 156 failures. That is the right unit for labelling
effort and the wrong unit for the confidence interval. Pairs within a run are
correlated — twenty failures from one broken deploy are one event, not 190
independent observations — so `bootstrapPairF1` resamples **runs**. The spike
has nine of them.

Run end-to-end on the machine labels, the clustering baseline reports:

```
pairwise precision 0.976  recall 0.408  F1 0.575
F1 95% bootstrap over runs: [0.188, 0.926] (n=9 runs)
```

An interval 0.74 wide clears no threshold and rejects none. Resampling from the
observed between-run spread of per-run F1 gives the scaling:

```
 runs   95% interval        width
    9   [0.231, 0.894]     0.663
   20   [0.280, 0.741]     0.461
   40   [0.379, 0.702]     0.323
   80   [0.476, 0.697]     0.221
  160   [0.510, 0.664]     0.154
  320   [0.530, 0.639]     0.109
```

Around **80 labelled runs** is where the lower bound starts to mean something,
and even there the interval is ±0.11. This is a property of how variable real
runs are, not of the estimator: the observed per-run F1 spans 0.007 to 1.000.

Two consequences, both about the shape of the labelling effort rather than its
size:

1. Gate 0's "1000 labelled failures" is satisfiable by a handful of large runs
   and would still yield an uninformative interval. **Many small runs beat few
   large ones** — the corpus median is 3 failures per run, and those cheap runs
   are worth more per labelling minute than another 200-failure suite collapse.
2. The 156-failure spike is a pilot for the *procedure* — does the labelling
   task cohere, do two labellers agree, is the payload separable — and cannot
   settle any F1 claim. Reporting an F1 point estimate from it, without the
   interval beside it, would be the exact error §2 forbids.

The agreement and separability numbers are less exposed: Cohen's kappa and the
separability rate are per-failure, not per-pair, so 156 failures is a real
sample for those. Only the pair-based clustering metric collapses to n=9.

### Gate figures are computed over the committable corpus, not the disk

Two categories of harvested run are kept on disk and out of git: copyleft
(GPL/LGPL/AGPL and similar reciprocal licences) and any licence GitHub could
not identify. crux itself is Apache-2.0, and the stored payload — failure
messages and stack traces — is arguably factual CI output rather than licensed
expression, but "arguably" is not a basis for putting it in git history.

The consequence is not the count, it is reproducibility. A held-out run is
present for every number computed on the harvesting machine and absent from
every number computed on a fresh clone. At the point this policy was confirmed:

```
held out: 53 run(s), 2678 failure(s), 12 repositories, 12 of them in the 5-24 band
```

Twelve in-band runs is material — the whole reason the band is tracked is that
the clustering interval is set by run count, and 80 is where the lower bound
starts to mean anything. Three of the four largest hold-outs are mid-size Java
projects (the SonarSource pair, Oblikovati) found by exactly the code-search
sourcing that works best, so this is a recurring cost rather than a one-off.

So `gateZeroStatus` evaluates every requirement over the committable runs and
reports the hold-out separately, above the gate table rather than below it,
because it changes what every number in that table is a number about. A gate
that only the harvesting machine can reproduce is not a gate; it is a claim
about one filesystem.

A third category joins them: a run file too large to redistribute. GitHub hard-
rejects a file over 100 MB, and one quarkus run reached **147 MB** — 1549
failures whose stack, stdout and stderr averaged about a megabyte each. It is
held out at a 50 MB threshold, with margin, since a repository carrying tens of
megabytes of JSON per run is unpleasant to clone long before git refuses it.

That hold-out is a redistribution limit and nothing more. The separate problem
with that run — 1549 failures contribute 1.2 million pairs, which swamps every
other run in the clustering metric — is **not** solved by keeping it out of
git, because the run is still on disk and still counted locally. Suite collapse
is handled where it belongs: `--max-failures` when sampling for labelling, and
the per-run F1 table that makes one run's dominance visible. Conflating the two
would be tempting and wrong, because it would imply the other eight runs over
200 failures are safe merely by being smaller files.

`corpus holdout` lists the affected runs and `--write` regenerates the block in
`.gitignore`. It is regenerated rather than maintained, because the list
changes with every harvest and a stale one is how copyleft content reaches git
history without anyone deciding it should.

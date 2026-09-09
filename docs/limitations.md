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
cannot attribute 1137 of 2076 failures (55%), which arrive as JUnit XML from
producers that leave no distinguishing tell.

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

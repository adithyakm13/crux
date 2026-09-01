# Contributing to crux

A contributor should be able to clone, install, test and make a meaningful
change in under an hour. If that takes you longer, that is a **P1 bug in this
repository**, not a gap in the documentation — please open an issue saying where
the hour went.

## Setup

Node 20 or newer, and pnpm 10 or newer. Node 25 no longer bundles corepack, so
install pnpm directly:

```bash
npm i -g pnpm@10
```

```bash
git clone https://github.com/cruxci/crux
cd crux
pnpm install
pnpm build
pnpm test
```

TypeScript sources import each other with `.ts` specifiers and are compiled with
`rewriteRelativeImportExtensions`, so `node --test` runs the sources directly
with no build step and no loader.

## The rules that are not negotiable

These come from the specification and are the reason crux is worth using. A pull
request that breaks one of them will not be merged regardless of how good the
rest of it is.

**No fabricated numbers.** Not in the README, not in docs, not in CLI examples,
not in a test fixture presented as real output. Every number a user sees is
computed or cited. No hand-written sample output ships — it will be wrong, and
it is the first thing a sceptical reader checks.

**`UNKNOWN` is a first-class answer.** A change that makes crux guess in order to
avoid saying `UNKNOWN` makes the product worse, because users calibrate on early
wrong answers and never come back.

**Every gate is evaluated on the lower bound of an interval.** A point estimate
is not evidence. Proportions use Wilson; clustering scores bootstrap over
**runs**, never over pairs — pairs within a run are strongly correlated and
resampling them produces intervals several times too narrow.

**Input is hostile.** Test results come from CI, which runs code from pull
requests. Every parser change must keep the caps, must not resolve external
entities, must not let any parsed value reach the filesystem or a shell, and
must fail with a bounded error rather than exhausting memory.

**Every derived artifact carries its algorithm version.** If you change
normalization, fingerprinting, clustering or the rules engine, bump the matching
constant in `packages/core/src/versions.ts`. Old rows stay valid and comparable;
they are never silently compared against new ones.

**Attempts are the grain.** A test that ran three times is three attempts.
Retries are evidence, not noise to be collapsed.

**Cannot do it correctly yet?** Document the limitation in
`docs/limitations.md`, provide a safe fallback, and add a roadmap entry. Never
pretend.

## Tests

- **The corpus is the test** for clustering and classification. A unit test
  asserting that a hand-picked pair clusters together is worth less than one
  point of F1.
- **Property tests** for normalization: idempotent, total, never throws on any
  corpus input.
- **Golden files** for every parser, including malformed, truncated and
  adversarial input.
- **CLI tests** invoke a real process and assert on stdout, stderr and exit
  code — not by importing the command handler.

```bash
pnpm test
pnpm typecheck
```

## Style

Match the surrounding code. Comments explain *why* a decision was made,
especially where the obvious implementation is wrong — those comments are load
bearing and should not be deleted as noise.

Prefer deletion. Prefer the standard library. No abstraction with one
implementation. No dependency for what ten lines do. Adding a dependency with a
large transitive tree, a new language, or a new service needs the tradeoff
explained in the pull request before the code.

## Commits and versioning

Semantic versioning, applied independently to the CLI, the schemas, the plugin
SDK, the fingerprint algorithm and the API, because they change at different
rates.

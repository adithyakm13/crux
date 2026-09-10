
## Offline worksheets

The interactive labeller is a readline loop. For 156 failures that is a long
sitting, and it cannot be handed to a second labeller without asking them to
install a toolchain — which Gate 0 needs, twice.

`corpus worksheet` writes the selection as one JSON file to edit anywhere:

```
corpus worksheet --selection corpus/spike-selection.json \
  --out corpus/worksheets/spike-full.json --context full
corpus import --file corpus/worksheets/spike-full.json --labeler <name>
```

Two fields per entry, `group` and `category`, plus an optional `note`. Blank
entries are skipped, so a worksheet can be filled over several sittings.

Two properties are enforced rather than trusted:

- **`context` is stamped into the file** and restored on import, so a worksheet
  labelled with full context cannot be imported as payload-only. That swap
  would leave the separability rate a number about nothing.
- **A payload-only worksheet carries no identity at all** — not the repository,
  workflow, branch or commit, and not `corpusRunId` either, since that string
  embeds the repository (`github-actions:acme/app:1:1`). Entries are opaque
  (`e0001`) and a sidecar `*.key.json` maps them back. `import` reads the key;
  the labeller has no reason to open it.

The second point was caught by a test, not by review: the first implementation
carried `corpusRunId` into every payload-only entry and handed the labeller the
repository on all 156 rows.

Import rejects rather than repairs. A category the schema does not define, a
group without a category, an entry whose id cannot be resolved — all are errors.
A silently coerced label is worse than a failed import, because this corpus is
the thing every other number is checked against.

## The labelling page

`corpus ledger` renders a worksheet as one self-contained HTML file:

```
corpus ledger --worksheet corpus/worksheets/spike-full.json \
  --out corpus/worksheets/spike-full.html
```

Open it in a browser, or publish it as an Artifact so labels persist across
sittings and a remote second labeller needs nothing installed. Export from the
page and `corpus import` reads the result.

It exists for one reason beyond comfort. Group reuse is the whole game: a group
name that should have been reused but was retyped slightly differently is a
silent split, and splits are exactly what pairwise F1 measures. The page lists
every name the labeller has already used, run-local ones first, so reuse is a
click rather than an act of recall. Editing the JSON by hand gives no such
affordance, and puts the labeller one stray comma from a file that will not
import.

The page is built from a worksheet, never from the corpus. That is the whole
contamination argument: a payload-only page cannot leak the repository because
nothing downstream of `corpus worksheet` has ever seen it. Three properties are
tested rather than asserted — payload-only pages carry no provenance, only an
explicit field list reaches the page, and failure text containing `</script>`
is escaped so a CI log cannot close the data block and inject markup.

Nothing on the page shows machine labels or another labeller's answers. An
anchored second pass measures agreement with the anchor.

The two contexts build two differently named pages — **Root Cause Ledger** for
the primary pass, **Sealed Ledger** for the blind one. They are usually open
side by side, and a labeller who confuses the tabs has silently destroyed the
separability measurement.

`corpus ledger` reads the worksheet's key file when one sits beside it, for one
purpose: counting how often the payload names its own repository, which the
sealed page then states. Nothing from the key is embedded — the count reaches
the page, the mapping does not. See `docs/limitations.md` for why that count
matters and what it was on this sample.

Generated pages are gitignored. The template and builder are versioned; a
600KB rebuildable artifact is not.

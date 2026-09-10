
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

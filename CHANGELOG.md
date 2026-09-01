# Changelog

All notable changes are recorded here. Semantic versioning is applied
independently per surface: CLI, schemas, plugin SDK, fingerprint algorithm and
API each carry their own version.

## Unreleased

Phase 0 — evidence. No product CLI exists yet; that is deliberate. See
[ROADMAP.md](ROADMAP.md).

### Added

- `@cruxci/core`: framework-neutral domain model, independent algorithm version
  lines, schema-version window enforcement, and the statistics every gate is
  evaluated with (Wilson intervals, deterministic bootstrap over runs, pairwise
  F1, Cohen's kappa, pairwise labeler agreement).
- `@cruxci/adapter-junit`: streaming JUnit XML adapter. DOCTYPE rejected
  outright; caps on bytes, depth, attributes per element, field size and total
  attempts; Surefire rerun elements parsed as separate attempts; ANSI and
  XML-illegal control characters stripped and counted.
- `@cruxci/adapter-playwright`: Playwright JSON reporter and blob report
  (`report.jsonl`), including per-attempt errors and retry indices.
- `@cruxci/engine`: normalization with individually toggleable rules, stack
  frame parsing and classification for V8, Python, JVM, Go and Ruby, BLAKE3
  fingerprinting with strict and loose variants, MinHash over character 5-grams
  with LSH banding, and a Levenshtein fallback for short messages.
- `@cruxci/corpus-tools`: corpus schema and validation, GitHub Actions
  harvester, labelling tool with contamination guards, Gate 0 status, labeler
  agreement, separability, and the baseline spike.
- `docs/evidence.md`, `docs/limitations.md`.

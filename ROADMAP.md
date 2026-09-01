# Roadmap

Each phase has a numeric gate. The next phase does not begin with the current
gate unmet — if a gate is missed, the number that was actually achieved is
reported instead.

Every gate is evaluated on the **lower** bound of a 95% interval: Wilson for
proportions, bootstrap over runs for clustering scores.

## Phase 0 — Evidence  *(current)*

Build `corpus/` and `docs/evidence.md`.

**Gate:** separability >= 60%, inter-labeler agreement >= 80%.

Done:

- Corpus schema, harvester, Gate 0 status command
- Labelling tool with contamination guards
- Agreement, separability and baseline-spike measurement
- Statistics: Wilson, bootstrap over runs, pairwise F1, Cohen's kappa
- JUnit XML and Playwright adapters (needed to extract failures at all)
- Normalization (§5), frame classification and fingerprinting (§6)

Outstanding:

- Corpus volume. Artifact retention means harvesting is a repeated operation;
  see `docs/evidence.md` §5.
- Labels. Two independent human labelers. No tooling substitute exists.
- The baseline spike, which needs 50 labelled failures across 8 multi-failure
  runs and is deliberately sequenced before the 1000-label investment.

## Phase 1 — Core, single-run

JUnit and Playwright parsing, normalization, fingerprinting, clustering,
deterministic classification, CLI `analyze` and `explain`. Git tiers 1-2.

Categories reachable and gated: `ENVIRONMENT_FAILURE`, `DEPENDENCY_FAILURE`,
`TEST_DEFECT`, `DATA_FAILURE`. `PRODUCT_REGRESSION`, `PERFORMANCE_REGRESSION`
and `FLAKY` require history and emit `UNKNOWN` with the missing evidence named.

**Gate:** pairwise F1 >= 0.80, fingerprint stability >= 99%, zero normalization
collisions on corpus, 10k results in < 5 s, per-category precision >= 0.85 on
the four categories above.

## Phase 2 — Distribution

GitHub Action, PR comment, Checks, `npx` install, cross-platform binaries.

**Gate:** clean install on macOS, Linux and Windows on ARM64 and x64, verified
in CI; PR comment on a real repository.

## Phase 3 — History

SQLite, rollups, test identity with alias review, flakiness engine, `history`,
`flaky`, quality gates over the dimensions that exist.

**Gate:** rename detection recall >= 90% at precision >= 98%; flake
classification precision >= 0.85; historical query < 1 s over 10M attempts.

## Phase 4 — Change intelligence

Git tiers 1-3, risk model, ownership, components, PostgreSQL.

**Gate:** risk correlation with escaped defects published, or explicitly
documented as uncalibrated — in the UI, not only in the docs.

## Phase 5 — Selection and dashboard

Coverage mapping, learned correlation, test selection, dashboard.

**Gate:** selection historical recall >= 95% on a time-ordered forward replay
across >= 200 runs, with the replay set size and cutoff date published.

## Phase 6 — Ecosystem

Plugin SDK, pytest, Cypress, AI providers, OpenTelemetry correlation,
performance intelligence.

## Explicitly not in Phase 1-2

Dashboard, server, AI, PostgreSQL, plugin SDK, flakiness, risk, selection,
quality score, demo application, telemetry — regardless of how easy any of them
looks.

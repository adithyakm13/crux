/**
 * `corpus sample` — choose which runs enter the labelled subset.
 *
 * Labelling is the scarce resource: a person can label maybe 100 failures in a
 * sitting, out of thousands. Which 100 decides what every downstream number
 * means, so the choice is an algorithm with a written-down policy rather than
 * "whatever the loop reached first".
 *
 * Three properties the corpus forces on us:
 *
 *  1. **Suite collapses.** Several runs carry hundreds of failures because one
 *     import broke, not because there are hundreds of root causes. Labelling
 *     them produces near-duplicate rows, and since the clustering metric is
 *     pair-based — a run of n failures contributes n(n-1)/2 pairs — one such run
 *     outweighs a small one by four orders of magnitude in any pooled score.
 *
 *  2. **Repository concentration.** The top three repositories supply most
 *     failures. Sampling proportionally would measure those three.
 *
 *  3. **Framework skew.** The app-frame signal is available for JVM and Python
 *     stacks and absent for Playwright and jest, so a sample drawn from one
 *     family measures that family rather than the algorithm.
 *
 * The policy is therefore: exclude collapses, cap runs per repository, and fill
 * framework strata round-robin so no family dominates. Deterministic given a
 * seed, so the selection is reproducible and reviewable.
 *
 * What it will NOT do is quietly return an unbalanced sample. Strata it could
 * not fill are reported as gaps, because a sample that silently omits
 * Playwright is worse than one that says it omitted Playwright.
 */

import { createHash } from 'node:crypto';
import { makeRng } from '@cruxci/core';
import type { CorpusRun } from './schema.ts';
import { detectFramework } from './status.ts';

export interface SampleOptions {
  /** Target number of failures to label. The last run may overshoot slightly. */
  targetFailures?: number;
  /** Runs smaller than this carry too few pairs to inform clustering. */
  minFailures?: number;
  /** Runs larger than this are suite collapses, not many root causes. */
  maxFailures?: number;
  /** Cap on runs drawn from any one repository. */
  maxRunsPerRepo?: number;
  seed?: number;
}

export interface SampleResult {
  runs: { corpusRunId: string; repo: string; failures: number; framework: string }[];
  totalFailures: number;
  /** Pairs the selection yields — the actual currency of a clustering score. */
  totalPairs: number;
  /** Failure-level framework coverage of the sample, keyed by each failure's own framework. */
  byFramework: Record<string, { runs: number; failures: number }>;
  /** Share of the corpus's failures for each framework, for comparison. */
  corpusMix: Record<string, number>;
  /** The sample's share, so under-representation is visible rather than implied. */
  sampleMix: Record<string, number>;
  byRepo: Record<string, number>;
  /** Frameworks present in the corpus that the sample could not include. */
  gaps: { framework: string; reason: string }[];
  excluded: { tooSmall: number; tooLarge: number; repoCapped: number };
  policy: Required<SampleOptions>;
  /** Digest of the selected run set, so a stale selection is detectable. */
  digest: string;
}

const DEFAULTS: Required<SampleOptions> = {
  targetFailures: 100,
  minFailures: 5,
  maxFailures: 40,
  maxRunsPerRepo: 3,
  seed: 0x5a3d1e,
};

/** The framework most of a run's failures came from. */
function dominantFramework(run: CorpusRun): string {
  const counts = new Map<string, number>();
  for (const f of run.failures) {
    const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 'unknown';
  let bestN = -1;
  for (const [k, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export function sampleForLabelling(runs: CorpusRun[], options: SampleOptions = {}): SampleResult {
  const policy: Required<SampleOptions> = { ...DEFAULTS, ...options };
  const rng = makeRng(policy.seed);

  const excluded = { tooSmall: 0, tooLarge: 0, repoCapped: 0 };
  const eligible: { run: CorpusRun; framework: string }[] = [];
  for (const run of runs) {
    const n = run.failures.length;
    if (n < policy.minFailures) {
      excluded.tooSmall++;
      continue;
    }
    if (n > policy.maxFailures) {
      excluded.tooLarge++;
      continue;
    }
    eligible.push({ run, framework: dominantFramework(run) });
  }

  // Shuffle deterministically, so repeated runs of the command agree and so the
  // selection within a stratum is not just "whatever the directory listing
  // happened to order first".
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
  }

  const strata = new Map<string, { run: CorpusRun; framework: string }[]>();
  for (const e of eligible) {
    let s = strata.get(e.framework);
    if (s === undefined) {
      s = [];
      strata.set(e.framework, s);
    }
    s.push(e);
  }
  // Smallest stratum first: a family with two eligible runs contributes both
  // before a family with twenty contributes its third.
  const order = [...strata.keys()].sort(
    (a, b) => strata.get(a)!.length - strata.get(b)!.length || a.localeCompare(b),
  );

  const chosen: SampleResult['runs'] = [];
  const perRepo = new Map<string, number>();
  let total = 0;
  let progress = true;
  while (total < policy.targetFailures && progress) {
    progress = false;
    for (const framework of order) {
      if (total >= policy.targetFailures) break;
      const bucket = strata.get(framework)!;
      while (bucket.length > 0) {
        const next = bucket.shift()!;
        const repo = next.run.source.repo;
        if ((perRepo.get(repo) ?? 0) >= policy.maxRunsPerRepo) {
          excluded.repoCapped++;
          continue;
        }
        perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
        chosen.push({
          corpusRunId: next.run.corpusRunId,
          repo,
          failures: next.run.failures.length,
          framework,
        });
        total += next.run.failures.length;
        progress = true;
        break;
      }
    }
  }

  // Coverage is counted per failure, by that failure's own framework — not by
  // the run's dominant label. A framework can be a large share of the corpus
  // while never dominating a single run: jest and Playwright together are 689
  // failures here and dominate none, so a run-level count reported no gap while
  // the sample contained almost none of them.
  const byId = new Map(runs.map((r) => [r.corpusRunId, r]));
  const byFramework: Record<string, { runs: number; failures: number }> = {};
  for (const c of chosen) {
    const run = byId.get(c.corpusRunId);
    if (run === undefined) continue;
    const seen = new Set<string>();
    for (const f of run.failures) {
      const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
      const b = (byFramework[k] ??= { runs: 0, failures: 0 });
      b.failures++;
      if (!seen.has(k)) {
        b.runs++;
        seen.add(k);
      }
    }
  }
  const byRepo: Record<string, number> = {};
  for (const c of chosen) byRepo[c.repo] = (byRepo[c.repo] ?? 0) + c.failures;

  // Gaps: frameworks the corpus has but the sample does not. Reported, never
  // silently absent — a sample missing Playwright measures something narrower
  // than "clustering", and the reader has to be told which.
  const corpusCounts: Record<string, number> = {};
  let corpusTotal = 0;
  for (const run of runs) {
    for (const f of run.failures) {
      const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
      corpusCounts[k] = (corpusCounts[k] ?? 0) + 1;
      corpusTotal++;
    }
  }
  const sampleTotal = Object.values(byFramework).reduce((n, b) => n + b.failures, 0);
  const corpusMix: Record<string, number> = {};
  const sampleMix: Record<string, number> = {};
  for (const [k, n] of Object.entries(corpusCounts)) {
    corpusMix[k] = corpusTotal === 0 ? 0 : n / corpusTotal;
    sampleMix[k] = sampleTotal === 0 ? 0 : (byFramework[k]?.failures ?? 0) / sampleTotal;
  }

  // A gap is a framework that is a real part of the corpus but barely present
  // in the sample. Both conditions matter: absent-and-negligible is not worth
  // reporting, absent-and-substantial changes what the result means.
  const gaps: SampleResult['gaps'] = [];
  for (const framework of Object.keys(corpusCounts).sort()) {
    const corpusShare = corpusMix[framework] ?? 0;
    const sampleShare = sampleMix[framework] ?? 0;
    if (corpusShare < 0.02) continue;
    if (sampleShare >= corpusShare / 3) continue;
    const dominates = runs.some(
      (r) =>
        dominantFramework(r) === framework &&
        r.failures.length >= policy.minFailures &&
        r.failures.length <= policy.maxFailures,
    );
    gaps.push({
      framework,
      reason:
        `${(corpusShare * 100).toFixed(0)}% of corpus failures, ` +
        `${(sampleShare * 100).toFixed(0)}% of the sample — ` +
        (dominates
          ? 'eligible runs exist but the target was reached first'
          : `no run of ${policy.minFailures}-${policy.maxFailures} failures is ` +
            `dominated by it; it appears only inside suite collapses or mixed runs`),
    });
  }

  const h = createHash('sha256');
  for (const id of chosen.map((c) => c.corpusRunId).sort()) h.update(id + '\n');

  return {
    runs: chosen,
    totalFailures: total,
    totalPairs: chosen.reduce((n, c) => n + (c.failures * (c.failures - 1)) / 2, 0),
    byFramework,
    corpusMix,
    sampleMix,
    byRepo,
    gaps,
    excluded,
    policy,
    digest: h.digest('hex').slice(0, 12),
  };
}

export function formatSample(r: SampleResult): string {
  const lines: string[] = [];
  lines.push(
    `labelling sample: ${r.runs.length} run(s), ${r.totalFailures} failure(s), ` +
      `${r.totalPairs.toLocaleString('en-US')} pairs (sample ${r.digest})`,
  );
  lines.push(
    `policy: ${r.policy.minFailures}-${r.policy.maxFailures} failures per run, ` +
      `max ${r.policy.maxRunsPerRepo} runs per repo, target ${r.policy.targetFailures} failures, ` +
      `seed ${r.policy.seed}`,
  );
  lines.push('');
  const w = Math.max(12, ...Object.keys(r.byFramework).map((k) => k.length));
  lines.push(`  ${'framework'.padEnd(w)}  runs  failures   sample%   corpus%`);
  for (const [k, v] of Object.entries(r.byFramework).sort((a, b) => b[1].failures - a[1].failures)) {
    lines.push(
      `  ${k.padEnd(w)}  ${String(v.runs).padStart(4)}  ${String(v.failures).padStart(8)}   ` +
        `${((r.sampleMix[k] ?? 0) * 100).toFixed(0).padStart(6)}%   ` +
        `${((r.corpusMix[k] ?? 0) * 100).toFixed(0).padStart(6)}%`,
    );
  }
  lines.push('');
  for (const c of r.runs) {
    lines.push(`  ${String(c.failures).padStart(4)}  ${c.framework.padEnd(w)}  ${c.repo}`);
  }
  if (r.gaps.length > 0) {
    lines.push('');
    lines.push('gaps — frameworks in the corpus but NOT in this sample:');
    for (const g of r.gaps) lines.push(`  ${g.framework}: ${g.reason}`);
    lines.push(
      '  Any result from this sample describes the frameworks above, not those.',
    );
  }
  lines.push('');
  lines.push(
    `excluded: ${r.excluded.tooSmall} run(s) under ${r.policy.minFailures} failures, ` +
      `${r.excluded.tooLarge} over ${r.policy.maxFailures} (suite collapses), ` +
      `${r.excluded.repoCapped} past the per-repo cap`,
  );
  return lines.join('\n');
}

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
  /**
   * Instead of discarding runs over `maxFailures`, include a deterministic
   * slice of this many failures from them.
   *
   * A suite collapse is not unlabelable in principle — it is just too big to
   * label whole. Slicing keeps frameworks that appear ONLY in collapses
   * reachable: every jest and Playwright failure in this corpus lives in three
   * 500+ failure runs, so without this they cannot be labelled at all.
   *
   * The pairs from a sliced run are a subsample of that run's pairs, and are
   * reported as such — a score over them is not a score over the whole run.
   */
  sliceLargeRuns?: number;
  /**
   * Minimum failures per framework the sample tries to reach, for any framework
   * that is a material share of the corpus.
   *
   * The goal is COVERAGE, not proportional representation. Matching the corpus
   * mix would spend the whole budget on the two biggest families — this corpus
   * is 59% unidentified and 25% jest — and leave nothing to say about the rest.
   * Per-framework F1 needs every family present, not every family present in
   * proportion.
   */
  minPerFramework?: number;
  /** Slices are one per repository: three slices of one collapse is one repo's data. */
  maxSlicesPerRepo?: number;
  seed?: number;
}

export interface SampleResult {
  runs: {
    corpusRunId: string;
    repo: string;
    failures: number;
    framework: string;
    /** Present only for a sliced run: the exact failures to label. */
    failureIds?: string[];
    sliced?: boolean;
  }[];
  /** How many selected runs are slices of a larger run. */
  slicedRuns: number;
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
  sliceLargeRuns: 0,
  minPerFramework: 15,
  maxSlicesPerRepo: 1,
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
    if (n > policy.maxFailures && policy.sliceLargeRuns <= 0) {
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

  // Selection is greedy on failure-level coverage deficit, not on a per-run
  // "dominant framework" stratum.
  //
  // Stratifying by dominant framework cannot reach a framework that never
  // dominates a run. jest is 25% of this corpus's failures and dominates not one
  // run — it lives inside mixed runs and suite collapses — so a stratified
  // selection reported no jest gap while containing no jest. Deficit-driven
  // selection asks a different question at each step: which framework is most
  // under-represented right now, and which remaining run carries the most
  // failures of it.
  const composition = new Map<string, Map<string, number>>();
  for (const e of eligible) {
    const c = new Map<string, number>();
    for (const f of e.run.failures) {
      const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    composition.set(e.run.corpusRunId, c);
  }

  const corpusCounts = new Map<string, number>();
  let corpusTotalAll = 0;
  for (const run of runs) {
    for (const f of run.failures) {
      const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
      corpusCounts.set(k, (corpusCounts.get(k) ?? 0) + 1);
      corpusTotalAll++;
    }
  }

  const chosen: SampleResult['runs'] = [];
  const perRepo = new Map<string, number>();
  const have = new Map<string, number>();
  const perRepoSlices = new Map<string, number>();
  const remaining = [...eligible];
  let total = 0;

  while (total < policy.targetFailures && remaining.length > 0) {
    // Coverage first: any material framework still under the per-framework
    // floor is the most wanted. Only once every family clears the floor does
    // the remaining budget go to whoever is furthest below the corpus mix.
    let wanted: string | null = null;
    let worst = -Infinity;
    for (const [k, n] of [...corpusCounts].sort((a, b) => a[0].localeCompare(b[0]))) {
      const share = n / Math.max(1, corpusTotalAll);
      if (share < 0.02) continue; // noise, not a family worth reserving budget for
      const floorDeficit = policy.minPerFramework - (have.get(k) ?? 0);
      const mixDeficit = share * policy.targetFailures - (have.get(k) ?? 0);
      // Floor deficits are ranked above mix deficits by a wide margin.
      const deficit = floorDeficit > 0 ? 1000 + floorDeficit : mixDeficit;
      if (deficit > worst) {
        worst = deficit;
        wanted = k;
      }
    }

    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const e = remaining[i]!;
      if ((perRepo.get(e.run.source.repo) ?? 0) >= policy.maxRunsPerRepo) continue;
      const wouldSlice =
        e.run.failures.length > policy.maxFailures && policy.sliceLargeRuns > 0;
      if (wouldSlice && (perRepoSlices.get(e.run.source.repo) ?? 0) >= policy.maxSlicesPerRepo) {
        continue;
      }
      const score = wanted === null ? 1 : (composition.get(e.run.corpusRunId)?.get(wanted) ?? 0);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // everything left is repo-capped
    if (bestScore === 0) {
      // No remaining run supplies the most-wanted framework. Fall back to the
      // largest remaining run so the target is still approached, rather than
      // stalling on a framework nothing can satisfy.
      // The fallback must respect the same caps as the primary pick, or a repo
      // whose slice quota is spent gets a second slice through the back door.
      const admissible = (e: (typeof remaining)[number]): boolean => {
        if ((perRepo.get(e.run.source.repo) ?? 0) >= policy.maxRunsPerRepo) return false;
        const wouldSlice =
          e.run.failures.length > policy.maxFailures && policy.sliceLargeRuns > 0;
        return !(
          wouldSlice && (perRepoSlices.get(e.run.source.repo) ?? 0) >= policy.maxSlicesPerRepo
        );
      };
      let fallback = -1;
      for (let i = 0; i < remaining.length; i++) {
        if (!admissible(remaining[i]!)) continue;
        if (fallback === -1 || remaining[i]!.run.failures.length > remaining[fallback]!.run.failures.length) {
          fallback = i;
        }
      }
      if (fallback === -1) break;
      bestIdx = fallback;
    }

    const picked = remaining.splice(bestIdx, 1)[0]!;
    const repo = picked.run.source.repo;
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);

    const oversized =
      picked.run.failures.length > policy.maxFailures && policy.sliceLargeRuns > 0;
    let takenIds: string[] | null = null;
    if (oversized) {
      perRepoSlices.set(repo, (perRepoSlices.get(repo) ?? 0) + 1);
      // Bias the slice toward the framework we are short of, then fill with the
      // rest, so slicing a 600-failure jest collapse actually yields jest.
      // Spend the slice on every framework still short of the floor, round-robin,
      // not just the single most-wanted one. A mixed collapse often carries two
      // under-represented families — this corpus's only jest failures and its
      // only Playwright failures live in the same three runs — and a slice that
      // serves one leaves the other unreachable, since a repo gets one slice.
      const short = new Set<string>();
      for (const [k, n] of corpusCounts) {
        if (n / Math.max(1, corpusTotalAll) < 0.02) continue;
        if ((have.get(k) ?? 0) < policy.minPerFramework) short.add(k);
      }
      const buckets = new Map<string, string[]>();
      for (const f of [...picked.run.failures].sort((a, b) =>
        a.failureId.localeCompare(b.failureId),
      )) {
        const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
        const key = short.has(k) ? k : '\u0000rest';
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(f.failureId);
      }
      const wantedFirst = [...short].sort((a, b) =>
        a === wanted ? -1 : b === wanted ? 1 : a.localeCompare(b),
      );
      const order = [...wantedFirst, '\u0000rest'].filter((k) => buckets.has(k));
      const out: string[] = [];
      let cursor = 0;
      while (out.length < policy.sliceLargeRuns && order.length > 0) {
        const key = order[cursor % order.length]!;
        const bucket = buckets.get(key)!;
        if (bucket.length === 0) {
          order.splice(cursor % order.length, 1);
          continue;
        }
        out.push(bucket.shift()!);
        cursor++;
      }
      takenIds = out.sort();
    }

    const counted = takenIds === null ? picked.run.failures : picked.run.failures.filter((f) => takenIds!.includes(f.failureId));
    for (const f of counted) {
      const k = detectFramework(f.sourceFile, f.stackText, f.errorType);
      have.set(k, (have.get(k) ?? 0) + 1);
    }

    chosen.push({
      corpusRunId: picked.run.corpusRunId,
      repo,
      failures: counted.length,
      framework: picked.framework,
      ...(takenIds === null ? {} : { failureIds: takenIds, sliced: true }),
    });
    total += counted.length;
  }

  for (const e of remaining) {
    if ((perRepo.get(e.run.source.repo) ?? 0) >= policy.maxRunsPerRepo) excluded.repoCapped++;
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
    const only = c.failureIds === undefined ? null : new Set(c.failureIds);
    for (const f of run.failures) {
      if (only !== null && !only.has(f.failureId)) continue;
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
  const corpusTotal = corpusTotalAll;
  const sampleTotal = Object.values(byFramework).reduce((n, b) => n + b.failures, 0);
  const corpusMix: Record<string, number> = {};
  const sampleMix: Record<string, number> = {};
  for (const [k, n] of corpusCounts) {
    corpusMix[k] = corpusTotal === 0 ? 0 : n / corpusTotal;
    sampleMix[k] = sampleTotal === 0 ? 0 : (byFramework[k]?.failures ?? 0) / sampleTotal;
  }

  // A gap is a framework that is a real part of the corpus but barely present
  // in the sample. Both conditions matter: absent-and-negligible is not worth
  // reporting, absent-and-substantial changes what the result means.
  const gaps: SampleResult['gaps'] = [];
  for (const framework of [...corpusCounts.keys()].sort()) {
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
    slicedRuns: chosen.filter((c) => c.sliced === true).length,
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
    lines.push(
      `  ${String(c.failures).padStart(4)}  ${c.framework.padEnd(w)}  ${c.repo}` +
        (c.sliced === true ? '  [slice of a larger run]' : ''),
    );
  }
  if (r.slicedRuns > 0) {
    lines.push('');
    lines.push(
      `  ${r.slicedRuns} run(s) are slices of a suite collapse. Their pairs are a ` +
        `subsample of that run's pairs, so a score over them is not a score over ` +
        `the whole run.`,
    );
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

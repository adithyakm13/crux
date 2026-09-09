/**
 * The baseline spike (§2, "Before spending on 1000 labels").
 *
 * Cluster labelled failures with the crudest possible rule — exact loose
 * fingerprint match, no graph, no weights — and measure pairwise F1 against the
 * human labels. The spec's reading of the result:
 *
 *   near 0.75  the weighted graph in §8 is over-engineering; ship the simple thing
 *   near 0.30  the problem is genuinely hard, and we know before building the corpus
 *   near 0.05  the payload does not carry the signal; stop and reconsider
 *
 * The number this produces is only meaningful over runs that have labels. Runs
 * without labels are reported as excluded, never quietly counted as agreement.
 */

import {
  bootstrapPairF1,
  pairCounts,
  prf,
  sumPairCounts,
  type Interval,
  type PairCounts,
} from '@cruxci/core';
import { fingerprint, type FingerprintOptions } from '@cruxci/engine';
import type { CorpusRun, RunLabels } from './schema.ts';
import { detectFramework } from './status.ts';

export interface BaselineRunResult {
  corpusRunId: string;
  repo: string;
  failures: number;
  /** Groups the labeller identified, and groups the baseline produced. */
  labelledGroups: number;
  predictedGroups: number;
  counts: PairCounts;
  precision: number;
  recall: number;
  f1: number;
}

export interface StratumResult {
  key: string;
  /** Failures of this stratum that were scored. */
  failures: number;
  counts: PairCounts;
  precision: number;
  recall: number;
  f1: number;
  interval: Interval;
  runs: number;
}

export interface BaselineReport {
  strategy: string;
  labeler: string;
  runsScored: number;
  runsExcluded: { corpusRunId: string; reason: string }[];
  failuresScored: number;
  pairsScored: number;
  aggregate: { precision: number; recall: number; f1: number };
  f1Interval: Interval;
  perRun: BaselineRunResult[];
  /**
   * F1 restricted to pairs whose BOTH members come from the same framework.
   *
   * The aggregate blends regimes that are not comparable. In this corpus the
   * deepest-app-frame signal — §8 weights it 0.60 — is available for 75% of
   * junit-jvm failures and 0% of jest ones, so a single number describes
   * whichever family happens to dominate the sample rather than the algorithm.
   */
  perFramework: StratumResult[];
  /** Same, by repository: concentration is the other way an aggregate misleads. */
  perRepo: StratumResult[];
  /**
   * Pairs spanning two different frameworks. Counted in the aggregate, absent
   * from every per-framework row, so the two need not add up and the reader is
   * told why.
   */
  crossFrameworkPairs: number;
}

/**
 * The crude rule. Two failures are the same cause when their loose fingerprints
 * are byte-identical. No graph, no weights, no similarity threshold.
 */
export function naiveLooseFingerprintGroups(
  run: CorpusRun,
  options: FingerprintOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of run.failures) {
    const fp = fingerprint(
      { errorType: f.errorType, message: f.message, stackText: f.stackText },
      options,
    );
    out.set(f.failureId, fp.looseHash);
  }
  return out;
}

export function runBaseline(
  runs: readonly CorpusRun[],
  labelsByRun: ReadonlyMap<string, RunLabels>,
  options: {
    labeler: string;
    strategy?: string;
    group?: (run: CorpusRun) => Map<string, string>;
    fingerprintOptions?: FingerprintOptions;
    seed?: number;
  },
): BaselineReport {
  const group =
    options.group ?? ((run: CorpusRun) => naiveLooseFingerprintGroups(run, options.fingerprintOptions));
  const perRun: BaselineRunResult[] = [];
  const excluded: { corpusRunId: string; reason: string }[] = [];

  for (const run of runs) {
    const labels = labelsByRun.get(run.corpusRunId);
    if (labels === undefined) {
      excluded.push({ corpusRunId: run.corpusRunId, reason: 'no labels' });
      continue;
    }
    // Score only failures this labeller actually labelled. Treating an unlabelled
    // failure as its own group would invent ground truth.
    const scored = run.failures.filter((f) => labels.labels[f.failureId] !== undefined);
    if (scored.length < 2) {
      excluded.push({
        corpusRunId: run.corpusRunId,
        reason: `only ${scored.length} labelled failure(s); a run needs 2 to contribute a pair`,
      });
      continue;
    }
    const predictedAll = group(run);
    const predicted = scored.map((f) => predictedAll.get(f.failureId) ?? `unpredicted:${f.failureId}`);
    const truth = scored.map((f) => labels.labels[f.failureId]!.group);
    const counts = pairCounts(predicted, truth);
    const score = prf(counts);
    perRun.push({
      corpusRunId: run.corpusRunId,
      repo: run.source.repo,
      failures: scored.length,
      labelledGroups: new Set(truth).size,
      predictedGroups: new Set(predicted).size,
      counts,
      precision: score.precision,
      recall: score.recall,
      f1: score.f1,
    });
  }

  const total = sumPairCounts(perRun.map((r) => r.counts));
  const agg = prf(total);
  const interval = bootstrapPairF1(
    perRun.map((r) => r.counts),
    options.seed === undefined ? {} : { seed: options.seed },
  );

  const strata = stratify(runs, labelsByRun, perRun, group, options.seed);

  return {
    strategy: options.strategy ?? 'naive-loose-fingerprint',
    labeler: options.labeler,
    runsScored: perRun.length,
    runsExcluded: excluded,
    failuresScored: perRun.reduce((n, r) => n + r.failures, 0),
    pairsScored: agg.pairs,
    aggregate: { precision: agg.precision, recall: agg.recall, f1: agg.f1 },
    f1Interval: interval,
    perRun,
    perFramework: strata.perFramework,
    perRepo: strata.perRepo,
    crossFrameworkPairs: strata.crossFrameworkPairs,
  };
}

/**
 * Score each framework and each repository on its own pairs.
 *
 * A pair belongs to a framework only when both of its failures do. That is the
 * only definition that does not require inventing an answer for a pair spanning
 * two families, and the pairs it leaves out are reported rather than dropped
 * silently.
 */
function stratify(
  runs: readonly CorpusRun[],
  labelsByRun: ReadonlyMap<string, RunLabels>,
  perRun: readonly BaselineRunResult[],
  group: (run: CorpusRun) => Map<string, string>,
  seed: number | undefined,
): { perFramework: StratumResult[]; perRepo: StratumResult[]; crossFrameworkPairs: number } {
  const scoredIds = new Set(perRun.map((r) => r.corpusRunId));
  const fwCounts = new Map<string, PairCounts[]>();
  const fwFailures = new Map<string, number>();
  const repoCounts = new Map<string, PairCounts[]>();
  const repoFailures = new Map<string, number>();
  let cross = 0;

  for (const run of runs) {
    if (!scoredIds.has(run.corpusRunId)) continue;
    const labels = labelsByRun.get(run.corpusRunId)!;
    const scored = run.failures.filter((f) => labels.labels[f.failureId] !== undefined);
    const predictedAll = group(run);
    const rows = scored.map((f) => ({
      framework: detectFramework(f.sourceFile, f.stackText, f.errorType),
      predicted: predictedAll.get(f.failureId) ?? `unpredicted:${f.failureId}`,
      truth: labels.labels[f.failureId]!.group,
    }));

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[i]!.framework !== rows[j]!.framework) cross++;
      }
    }

    const byFramework = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = byFramework.get(row.framework);
      if (bucket === undefined) byFramework.set(row.framework, [row]);
      else bucket.push(row);
    }
    for (const [framework, bucket] of byFramework) {
      fwFailures.set(framework, (fwFailures.get(framework) ?? 0) + bucket.length);
      if (bucket.length < 2) continue;
      const c = pairCounts(
        bucket.map((b) => b.predicted),
        bucket.map((b) => b.truth),
      );
      (fwCounts.get(framework) ?? fwCounts.set(framework, []).get(framework)!).push(c);
    }

    const repo = run.source.repo;
    repoFailures.set(repo, (repoFailures.get(repo) ?? 0) + rows.length);
    if (rows.length >= 2) {
      const c = pairCounts(
        rows.map((b) => b.predicted),
        rows.map((b) => b.truth),
      );
      (repoCounts.get(repo) ?? repoCounts.set(repo, []).get(repo)!).push(c);
    }
  }

  const build = (
    counts: Map<string, PairCounts[]>,
    failures: Map<string, number>,
  ): StratumResult[] =>
    [...counts]
      .map(([key, list]) => {
        const score = prf(sumPairCounts(list));
        return {
          key,
          failures: failures.get(key) ?? 0,
          counts: sumPairCounts(list),
          precision: score.precision,
          recall: score.recall,
          f1: score.f1,
          interval: bootstrapPairF1(list, seed === undefined ? {} : { seed }),
          runs: list.length,
        };
      })
      .sort((a, b) => b.counts.truePositives + b.counts.falsePositives - (a.counts.truePositives + a.counts.falsePositives) || a.key.localeCompare(b.key));

  return {
    perFramework: build(fwCounts, fwFailures),
    perRepo: build(repoCounts, repoFailures),
    crossFrameworkPairs: cross,
  };
}

export function formatBaselineReport(r: BaselineReport): string {
  const lines: string[] = [];
  const pct = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a');
  lines.push(`strategy: ${r.strategy}`);
  lines.push(`labeler:  ${r.labeler}`);
  lines.push(
    `scored ${r.runsScored} run(s), ${r.failuresScored} failure(s), ${r.pairsScored} pair(s)`,
  );
  if (r.runsExcluded.length > 0) {
    lines.push(`excluded ${r.runsExcluded.length} run(s):`);
    const byReason = new Map<string, number>();
    for (const e of r.runsExcluded) {
      const key = e.reason.replace(/\d+/g, 'N');
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    for (const [reason, n] of byReason) lines.push(`  ${n} x ${reason}`);
  }
  lines.push('');
  lines.push(
    `pairwise precision ${pct(r.aggregate.precision)}  ` +
      `recall ${pct(r.aggregate.recall)}  F1 ${pct(r.aggregate.f1)}`,
  );
  lines.push(
    `F1 95% bootstrap over runs: [${pct(r.f1Interval.lower)}, ${pct(r.f1Interval.upper)}] ` +
      `(n=${r.f1Interval.n} runs)`,
  );
  if (r.perFramework.length > 0) {
    lines.push('');
    lines.push('per-framework F1 (pairs where both failures share a framework):');
    const w = Math.max(10, ...r.perFramework.map((x) => x.key.length));
    for (const st of r.perFramework) {
      lines.push(
        `  ${st.key.padEnd(w)}  F1 ${pct(st.f1)}  [${pct(st.interval.lower)}, ${pct(st.interval.upper)}]  ` +
          `P ${pct(st.precision)}  R ${pct(st.recall)}  ` +
          `${String(st.failures).padStart(4)} failures, ${st.counts.truePositives + st.counts.falsePositives + st.counts.falseNegatives + st.counts.trueNegatives} pairs, ${st.runs} run(s)`,
      );
    }
    lines.push(
      `  ${r.crossFrameworkPairs} pair(s) span two frameworks: counted in the aggregate, ` +
        `absent from every row above, so these need not sum to the total.`,
    );
    lines.push(
      '  A single aggregate blends regimes that are not comparable — the app-frame ' +
        'signal §8 weights at 0.60 is available for some of these families and not others.',
    );
  }
  if (r.perRepo.length > 1) {
    lines.push('');
    lines.push('per-repository F1 (the corpus is concentrated; check no one repo carries the result):');
    const w = Math.max(10, ...r.perRepo.map((x) => x.key.length));
    for (const st of r.perRepo) {
      lines.push(
        `  ${st.key.padEnd(w)}  F1 ${pct(st.f1)}  ${String(st.failures).padStart(4)} failures, ${st.runs} run(s)`,
      );
    }
  }
  lines.push('');
  lines.push('per-run F1 (one bad run hiding inside a good mean is the failure mode):');
  const sorted = [...r.perRun].sort((a, b) => (a.f1 || 0) - (b.f1 || 0));
  for (const run of sorted) {
    lines.push(
      `  ${pct(run.f1)}  ${String(run.failures).padStart(4)} failures  ` +
        `${run.labelledGroups} labelled / ${run.predictedGroups} predicted groups  ${run.corpusRunId}`,
    );
  }
  return lines.join('\n');
}

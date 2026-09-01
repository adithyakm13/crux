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

/**
 * A static snapshot of the corpus, for the console.
 *
 * The console is a plain static site: there is no server, and there never
 * should be — the corpus is files in git, and a build step that reads those
 * files keeps the frontend honest about what it is showing. Everything here is
 * derived from `loadRuns` and `gateZeroStatus`, so the console cannot show a
 * number the CLI would not.
 *
 * Two things are carried that the CLI prints but never returns: the hold-out
 * split, and per-run detail. The console needs both to make the difference
 * between "on disk" and "in git" visible rather than a footnote.
 */

import {
  gateZeroStatus,
  detectFramework,
  loadAllLabels,
  type GateZeroStatus,
} from './status.ts';
import { holdOutReason, MAX_COMMITTABLE_RUN_BYTES } from './license.ts';
import { isMachineLabeler } from './schema.ts';
import { runBaseline } from './baseline.ts';
import type { CorpusRun } from './schema.ts';

export interface SnapshotRun {
  id: string;
  repo: string;
  workflow: string | null;
  event: string | null;
  branch: string | null;
  harvestedAt: string | null;
  license: string;
  failures: number;
  /** Distinct frameworks inferred from this run's failures, evidence only. */
  frameworks: string[];
  /** Non-null when the run is on disk but excluded from git. */
  heldOut: string | null;
  bytes: number;
}

export interface SnapshotLabeler {
  name: string;
  machine: boolean;
  failures: number;
  runs: number;
  categories: Record<string, number>;
  contexts: string[];
}

/**
 * The clustering baseline, per labeller whose labels exist.
 *
 * Carried so the console can show an interval rather than a point. A rate
 * without its interval is the error this whole project is organised against,
 * and a dashboard that printed 0.73 in large type would be committing it.
 */
export interface SnapshotBaseline {
  labeler: string;
  machine: boolean;
  strategy: string;
  runsScored: number;
  failuresScored: number;
  pairsScored: number;
  precision: number;
  recall: number;
  f1: number;
  lower: number;
  upper: number;
  level: number;
}

export interface Snapshot {
  schemaVersion: number;
  generatedAt: string;
  gate: GateZeroStatus;
  runs: SnapshotRun[];
  labelers: SnapshotLabeler[];
  /** Failure-size histogram over committable runs, the unit the gate counts. */
  sizeBands: { band: string; runs: number }[];
  baselines: SnapshotBaseline[];
}

const SNAPSHOT_SCHEMA_VERSION = 1;

function frameworksOfRun(run: CorpusRun): string[] {
  const seen = new Set<string>();
  for (const f of run.failures) {
    const inferred = detectFramework(f.sourceFile, f.stackText, f.errorType);
    seen.add(inferred !== 'unknown' && inferred !== null ? inferred : 'unknown');
  }
  return [...seen].sort();
}

function bandOf(n: number): string {
  if (n === 1) return '1';
  if (n <= 4) return '2-4';
  if (n <= 24) return '5-24';
  if (n <= 99) return '25-99';
  return '100+';
}

export async function buildSnapshot(
  corpusDir: string,
  runs: CorpusRun[],
  sizeOf: (run: CorpusRun) => number,
): Promise<Snapshot> {
  const gate = await gateZeroStatus(corpusDir, runs);
  const labelSets = await loadAllLabels(corpusDir, runs);

  const byLabeler = new Map<string, SnapshotLabeler>();
  for (const ls of labelSets) {
    let row = byLabeler.get(ls.labeler);
    if (row === undefined) {
      row = {
        name: ls.labeler,
        machine: isMachineLabeler(ls.labeler),
        failures: 0,
        runs: 0,
        categories: {},
        contexts: [],
      };
      byLabeler.set(ls.labeler, row);
    }
    row.runs++;
    if (!row.contexts.includes(ls.context)) row.contexts.push(ls.context);
    for (const label of Object.values(ls.labels)) {
      row.failures++;
      row.categories[label.category] = (row.categories[label.category] ?? 0) + 1;
    }
  }

  const snapshotRuns: SnapshotRun[] = runs.map((run) => {
    const bytes = sizeOf(run);
    const reason = holdOutReason(run, bytes, MAX_COMMITTABLE_RUN_BYTES);
    return {
      id: run.corpusRunId,
      repo: run.source.repo,
      workflow: run.source.workflowName ?? null,
      event: run.source.event ?? null,
      branch: run.source.headBranch ?? null,
      harvestedAt: run.source.retrievedAt ?? null,
      license: run.source.licenseSpdx ?? run.source.licenseRaw ?? 'none',
      failures: run.failures.length,
      frameworks: frameworksOfRun(run),
      heldOut: reason === null ? null : `${reason.kind}: ${reason.detail}`,
      bytes,
    };
  });

  // One baseline per labeller with labels. Scored over the runs that labeller
  // actually covered; the report already excludes the rest.
  const baselines: SnapshotBaseline[] = [];
  for (const name of byLabeler.keys()) {
    const byRun = new Map<string, (typeof labelSets)[number]>();
    for (const ls of labelSets) if (ls.labeler === name) byRun.set(ls.corpusRunId, ls);
    if (byRun.size === 0) continue;
    try {
      const report = runBaseline(runs, byRun, { labeler: name });
      if (report.pairsScored === 0) continue;
      baselines.push({
        labeler: name,
        machine: isMachineLabeler(name),
        strategy: report.strategy,
        runsScored: report.runsScored,
        failuresScored: report.failuresScored,
        pairsScored: report.pairsScored,
        precision: report.aggregate.precision,
        recall: report.aggregate.recall,
        f1: report.aggregate.f1,
        lower: report.f1Interval.lower,
        upper: report.f1Interval.upper,
        level: report.f1Interval.level,
      });
    } catch {
      // A labeller whose labels cannot be scored is simply absent from this
      // list; the gate does not depend on it.
    }
  }

  const bands = new Map<string, number>();
  for (const r of snapshotRuns) {
    if (r.heldOut !== null) continue;
    bands.set(bandOf(r.failures), (bands.get(bandOf(r.failures)) ?? 0) + 1);
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    gate,
    runs: snapshotRuns.sort((a, b) => b.failures - a.failures),
    labelers: [...byLabeler.values()].sort((a, b) => b.failures - a.failures),
    sizeBands: ['1', '2-4', '5-24', '25-99', '100+'].map((band) => ({
      band,
      runs: bands.get(band) ?? 0,
    })),
    baselines: baselines.sort((a, b) => Number(a.machine) - Number(b.machine)),
  };
}

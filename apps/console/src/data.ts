/**
 * The snapshot the console reads.
 *
 * These types mirror `packages/corpus-tools/src/snapshot.ts`. The console never
 * computes a gate figure of its own: a second implementation of the gate would
 * drift from the CLI's, and then two numbers would both claim to be Gate 0.
 * Everything here is display.
 */

export interface Requirement {
  id: string;
  description: string;
  observed: number;
  required: number;
  met: boolean;
  /** Present when the figure could not be computed at all. */
  note?: string;
}

export interface GateZeroStatus {
  corpusDir: string;
  heldOut: {
    runs: number;
    failures: number;
    repositories: number;
    runsWithAtLeast5Failures: number;
    runsInBand: number;
  };
  runs: number;
  failures: number;
  repositories: number;
  frameworksSeen: string[];
  unidentifiedFrameworkFailures: number;
  runsWithAtLeast5Failures: number;
  syntheticFraction: number;
  fidelityBreakdown: Record<string, number>;
  labelers: string[];
  labeledFailures: number;
  machineLabelers: string[];
  machineLabeledFailures: number;
  concentration: {
    topRunShare: number;
    topRepoShare: number;
    top3RepoShare: number;
    runsOver200Failures: number;
    medianFailuresPerRun: number;
    runsInBand: number;
    runsWithPairs: number;
  };
  requirements: Requirement[];
  met: boolean;
}

export interface SnapshotRun {
  id: string;
  repo: string;
  workflow: string | null;
  event: string | null;
  branch: string | null;
  harvestedAt: string | null;
  license: string;
  failures: number;
  frameworks: string[];
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
  sizeBands: { band: string; runs: number }[];
  baselines: SnapshotBaseline[];
}

export async function loadSnapshot(): Promise<Snapshot> {
  const res = await fetch(new URL('corpus.json', document.baseURI));
  if (!res.ok) {
    throw new Error(
      `corpus.json is missing (HTTP ${res.status}). Run \`pnpm run snapshot\` to generate it.`,
    );
  }
  return (await res.json()) as Snapshot;
}

export const pct = (x: number): string => (x * 100).toFixed(0) + '%';

export const num = (x: number): string => x.toLocaleString('en-US');

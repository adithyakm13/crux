/**
 * Corpus on-disk schema (§2, Gate 0).
 *
 * The corpus is specified in RUNS, not failures, because clustering quality is
 * only measurable within a run: a corpus of isolated failures yields zero pairs
 * to score.
 *
 * Two things are kept strictly apart on disk:
 *
 *  - `corpus/runs/**` — the evidence. Written by the harvester, never by hand.
 *  - `corpus/labels/<labeler>/**` — one directory per labeler. Separate files
 *    are what makes an independent second labeling possible at all; a shared
 *    file would let one labeler see the other's answers and destroy the
 *    inter-labeler agreement number before it is measured.
 */

import { SCHEMA_VERSION, assertReadableSchema, type Category, CATEGORIES } from '@cruxci/core';

/**
 * How much to trust a run's contents, in the order the spec ranks sources.
 * Synthetic runs are capped at 20% of the corpus and are always flagged,
 * because fault-injected failures are unrealistically clean and will flatter
 * every metric computed over them.
 */
export type Fidelity = 'artifact' | 'log-scrape' | 'synthetic';

export interface RunSource {
  provider: 'github-actions' | 'local' | 'synthetic';
  /** `owner/name`. */
  repo: string;
  /** Provider-side run identifier, as a string to avoid float precision loss. */
  providerRunId: string;
  runAttempt: number;
  url: string | null;
  workflowName: string | null;
  event: string | null;
  headSha: string | null;
  headBranch: string | null;
  /** Artifact ids the payload was extracted from, for reproducibility. */
  artifactIds: string[];
  /** SPDX id from the provider, or null when it could not be identified. */
  licenseSpdx: string | null;
  /** The provider's raw answer, so NOASSERTION stays distinguishable from absent. */
  licenseRaw: string | null;
  retrievedAt: string;
}

export interface CorpusFailure {
  /** Stable within the run. Labels reference this and nothing else. */
  failureId: string;
  /** File inside the artifact this record came from, for auditing. */
  sourceFile: string;
  /**
   * Adapter that parsed this record. Authoritative, unlike anything inferred
   * from the text. Optional because runs harvested before this field existed
   * do not carry it, and re-harvesting them is not always possible once the
   * upstream artifacts have expired.
   */
  producerAdapter?: string;
  shardIndex: number;
  attemptIndex: number;
  displayName: string;
  suitePath: string[];
  filePath: string | null;
  status: string;
  durationMs: number | null;
  errorType: string | null;
  message: string;
  stackText: string | null;
  stdout: string | null;
  stderr: string | null;
}

export interface CorpusRun {
  schemaVersion: number;
  /** `<provider>:<repo>:<runId>:<attempt>` — stable, human-readable, unique. */
  corpusRunId: string;
  source: RunSource;
  fidelity: Fidelity;
  /** Counts over everything parsed, not only what was kept. */
  counts: {
    attempts: number;
    failures: number;
    passed: number;
    skipped: number;
    filesParsed: number;
    filesRejected: number;
  };
  /** Parser warnings, kept so a suspicious corpus entry can be traced. */
  warnings: { code: string; count: number }[];
  failures: CorpusFailure[];
}

export type GroupId = string;

export interface FailureLabel {
  /**
   * Which failures in this run share a root cause. Any stable string; failures
   * with the same group had the same cause. A singleton gets its own group.
   */
  group: GroupId;
  category: Category;
  /** Free text. Why this call was made — invaluable when kappa is low. */
  note?: string;
}

export interface RunLabels {
  schemaVersion: number;
  corpusRunId: string;
  labeler: string;
  labeledAt: string;
  /**
   * What the labeler could see. `payload-only` is the separability condition
   * (§2): message, stack, stdout, timing, exit code — no repo, no git, no logs.
   */
  context: 'full' | 'payload-only';
  labels: Record<string, FailureLabel>;
}

// ---------------------------------------------------------------------------
// Validation. The corpus is the measurement instrument; a malformed entry that
// loads silently corrupts every gate number computed from it.
// ---------------------------------------------------------------------------

const CATEGORY_SET = new Set<string>(CATEGORIES);

export function validateCorpusRun(v: unknown, where: string): CorpusRun {
  const o = requireObject(v, where);
  assertReadableSchema(o['schemaVersion'], where);
  const run = o as unknown as CorpusRun;
  requireString(run.corpusRunId, `${where}: corpusRunId`);
  const src = requireObject(run.source, `${where}: source`) as unknown as RunSource;
  requireString(src.repo, `${where}: source.repo`);
  requireString(src.providerRunId, `${where}: source.providerRunId`);
  if (!Array.isArray(run.failures)) {
    throw new Error(`${where}: failures must be an array`);
  }
  const ids = new Set<string>();
  for (const [i, f] of run.failures.entries()) {
    requireString(f?.failureId, `${where}: failures[${i}].failureId`);
    if (ids.has(f.failureId)) {
      throw new Error(`${where}: duplicate failureId ${f.failureId}`);
    }
    ids.add(f.failureId);
    if (typeof f.message !== 'string') {
      throw new Error(`${where}: failures[${i}].message must be a string`);
    }
  }
  if (!['artifact', 'log-scrape', 'synthetic'].includes(run.fidelity)) {
    throw new Error(`${where}: unknown fidelity ${JSON.stringify(run.fidelity)}`);
  }
  return run;
}

export function validateRunLabels(v: unknown, where: string, run?: CorpusRun): RunLabels {
  const o = requireObject(v, where);
  assertReadableSchema(o['schemaVersion'], where);
  const labels = o as unknown as RunLabels;
  requireString(labels.corpusRunId, `${where}: corpusRunId`);
  requireString(labels.labeler, `${where}: labeler`);
  if (labels.context !== 'full' && labels.context !== 'payload-only') {
    throw new Error(`${where}: context must be "full" or "payload-only"`);
  }
  const entries = Object.entries(labels.labels ?? {});
  if (entries.length === 0) throw new Error(`${where}: no labels`);
  const known = run ? new Set(run.failures.map((f) => f.failureId)) : null;
  for (const [failureId, label] of entries) {
    if (known && !known.has(failureId)) {
      // A label for a failure that is not in the run means the corpus and the
      // labels have drifted apart. Every metric downstream would be wrong.
      throw new Error(
        `${where}: label references unknown failureId ${failureId}. ` +
          `Fix: re-harvest the run, or drop the stale label.`,
      );
    }
    requireString(label?.group, `${where}: labels[${failureId}].group`);
    if (!CATEGORY_SET.has(label.category)) {
      throw new Error(
        `${where}: labels[${failureId}].category ${JSON.stringify(label.category)} ` +
          `is not one of ${[...CATEGORY_SET].join(', ')}`,
      );
    }
  }
  return labels;
}

export function newCorpusRun(args: {
  source: RunSource;
  fidelity: Fidelity;
}): CorpusRun {
  return {
    schemaVersion: SCHEMA_VERSION,
    corpusRunId: makeCorpusRunId(args.source),
    source: args.source,
    fidelity: args.fidelity,
    counts: { attempts: 0, failures: 0, passed: 0, skipped: 0, filesParsed: 0, filesRejected: 0 },
    warnings: [],
    failures: [],
  };
}

export function makeCorpusRunId(source: RunSource): string {
  return `${source.provider}:${source.repo}:${source.providerRunId}:${source.runAttempt}`;
}

/** Filesystem-safe directory name for a corpus run id. */
export function corpusRunDir(corpusRunId: string): string {
  return corpusRunId.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function requireObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: expected an object, got ${describe(v)}`);
  }
  return v as Record<string, unknown>;
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${where}: expected a non-empty string, got ${describe(v)}`);
  }
  return v;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

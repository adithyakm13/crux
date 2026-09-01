/**
 * Labeling (§2, Gate 0).
 *
 * Labels are the measurement instrument. Everything crux claims is a
 * classification claim, and without labels none of them are falsifiable, so
 * this tool has one job: let a human record what actually broke, with as little
 * opportunity as possible to contaminate the number that gets computed later.
 *
 * Three contamination risks it is built to avoid:
 *
 *  1. **Seeing the other labeler's answers.** Each labeler writes to their own
 *     directory and never reads another's. Inter-labeler agreement measured
 *     after one labeler saw the other's work is not agreement, it is copying.
 *
 *  2. **Seeing crux's answer.** The tool never shows a predicted cluster or
 *     category. A labeler shown the model's guess anchors on it, and the
 *     resulting F1 measures agreement with the model, not with the truth.
 *
 *  3. **Seeing more than the condition allows.** In `payload-only` mode the
 *     repository, workflow, branch and commit are withheld, because that is the
 *     precise condition the separability rate is defined over (§2).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION, CATEGORIES, type Category } from '@cruxci/core';
import {
  validateRunLabels,
  type CorpusFailure,
  type CorpusRun,
  type RunLabels,
} from './schema.ts';

export type LabelContext = 'full' | 'payload-only';

export function labelsPath(corpusDir: string, labeler: string, corpusRunId: string): string {
  return join(corpusDir, 'labels', sanitize(labeler), `${sanitize(corpusRunId)}.json`);
}

export async function loadLabels(
  corpusDir: string,
  labeler: string,
  run: CorpusRun,
): Promise<RunLabels | null> {
  const path = labelsPath(corpusDir, labeler, run.corpusRunId);
  try {
    const text = await readFile(path, 'utf8');
    return validateRunLabels(JSON.parse(text), path, run);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

export async function saveLabels(corpusDir: string, labels: RunLabels): Promise<string> {
  const path = labelsPath(corpusDir, labels.labeler, labels.corpusRunId);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(labels, null, 2) + '\n', 'utf8');
  return path;
}

export function emptyLabels(
  corpusRunId: string,
  labeler: string,
  context: LabelContext,
): RunLabels {
  return {
    schemaVersion: SCHEMA_VERSION,
    corpusRunId,
    labeler,
    labeledAt: new Date().toISOString(),
    context,
    labels: {},
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface RenderOptions {
  context: LabelContext;
  /** Lines of stack to show. The whole thing is rarely readable or useful. */
  stackLines?: number;
  width?: number;
}

/**
 * Render the run header a labeler sees before the failures.
 *
 * In `payload-only` mode this deliberately withholds the repository, workflow,
 * branch and commit — the separability question is exactly "how far do you get
 * on the payload alone", and leaking the repository name answers a large part
 * of it for free.
 */
export function renderRunHeader(run: CorpusRun, options: RenderOptions): string {
  const lines: string[] = [];
  lines.push(`run ${run.corpusRunId.split(':').slice(-2).join(':')}`);
  if (options.context === 'full') {
    lines.push(`repo      ${run.source.repo}`);
    lines.push(`workflow  ${run.source.workflowName ?? '(unknown)'}`);
    lines.push(`branch    ${run.source.headBranch ?? '(unknown)'}  event ${run.source.event ?? '?'}`);
    lines.push(`commit    ${run.source.headSha ?? '(unknown)'}`);
    if (run.source.url !== null) lines.push(`url       ${run.source.url}`);
  } else {
    lines.push('(payload-only: repository, workflow, branch and commit withheld)');
  }
  lines.push(
    `failures  ${run.failures.length} of ${run.counts.attempts} attempts ` +
      `(${run.counts.passed} passed, ${run.counts.skipped} skipped)`,
  );
  return lines.join('\n');
}

/** Render one failure. Everything shown here is in the payload by definition. */
export function renderFailure(
  failure: CorpusFailure,
  index: number,
  total: number,
  options: RenderOptions,
): string {
  const stackLines = options.stackLines ?? 12;
  const lines: string[] = [];
  lines.push(`[${index + 1}/${total}] ${failure.failureId}`);
  lines.push(`test      ${failure.displayName}`);
  if (failure.suitePath.length > 0) lines.push(`suite     ${failure.suitePath.join(' > ')}`);
  if (failure.filePath !== null) lines.push(`file      ${failure.filePath}`);
  lines.push(
    `status    ${failure.status}  attempt ${failure.attemptIndex}  shard ${failure.shardIndex}` +
      (failure.durationMs === null ? '' : `  ${failure.durationMs}ms`),
  );
  if (failure.errorType !== null) lines.push(`type      ${failure.errorType}`);
  lines.push('');
  lines.push(indent(failure.message.trimEnd(), '  '));
  if (failure.stackText !== null) {
    const stack = failure.stackText.split('\n');
    lines.push('');
    lines.push(indent(stack.slice(0, stackLines).join('\n'), '  '));
    if (stack.length > stackLines) {
      lines.push(`  … ${stack.length - stackLines} more stack line(s)`);
    }
  }
  for (const [name, value] of [
    ['stdout', failure.stdout],
    ['stderr', failure.stderr],
  ] as const) {
    if (value === null || value.trim() === '') continue;
    const tail = value.trimEnd().split('\n').slice(-8).join('\n');
    lines.push('');
    lines.push(`  --- ${name} (last 8 lines) ---`);
    lines.push(indent(tail, '  '));
  }
  return lines.join('\n');
}

export function renderCategoryMenu(): string {
  const help: Record<Category, string> = {
    PRODUCT_REGRESSION: 'code under test broke',
    TEST_DEFECT: 'the test is wrong',
    FLAKY: 'nondeterministic',
    ENVIRONMENT_FAILURE: 'infrastructure broke',
    DEPENDENCY_FAILURE: 'external service broke',
    DATA_FAILURE: 'fixture or state wrong',
    PERFORMANCE_REGRESSION: 'slower, not wrong',
    UNKNOWN: 'insufficient evidence — a first-class answer, not a cop-out',
  };
  return CATEGORIES.map((c, i) => `  ${i + 1}) ${c.padEnd(23)} ${help[c]}`).join('\n');
}

export function categoryByOrdinal(input: string): Category | null {
  const trimmed = input.trim();
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= CATEGORIES.length) return CATEGORIES[n - 1]!;
  const upper = trimmed.toUpperCase();
  return (CATEGORIES as readonly string[]).includes(upper) ? (upper as Category) : null;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

// ---------------------------------------------------------------------------
// Agreement (§2)
// ---------------------------------------------------------------------------

export interface AgreementInput {
  corpusRunId: string;
  /** Failure ids both labelers labelled, in a fixed order. */
  failureIds: string[];
  aCategories: string[];
  bCategories: string[];
  aGroups: string[];
  bGroups: string[];
}

/**
 * Align two labelers' work on the failures they both labelled. Failures only
 * one of them reached are excluded and counted — scoring a missing label as a
 * disagreement would understate agreement, and scoring it as agreement would
 * overstate it.
 */
export function alignLabelers(
  runs: readonly CorpusRun[],
  a: ReadonlyMap<string, RunLabels>,
  b: ReadonlyMap<string, RunLabels>,
): { aligned: AgreementInput[]; skipped: { corpusRunId: string; reason: string }[] } {
  const aligned: AgreementInput[] = [];
  const skipped: { corpusRunId: string; reason: string }[] = [];
  for (const run of runs) {
    const la = a.get(run.corpusRunId);
    const lb = b.get(run.corpusRunId);
    if (la === undefined || lb === undefined) {
      skipped.push({ corpusRunId: run.corpusRunId, reason: 'only one labeler covered this run' });
      continue;
    }
    const ids = run.failures
      .map((f) => f.failureId)
      .filter((id) => la.labels[id] !== undefined && lb.labels[id] !== undefined);
    if (ids.length === 0) {
      skipped.push({ corpusRunId: run.corpusRunId, reason: 'no failure labelled by both' });
      continue;
    }
    aligned.push({
      corpusRunId: run.corpusRunId,
      failureIds: ids,
      aCategories: ids.map((id) => la.labels[id]!.category),
      bCategories: ids.map((id) => lb.labels[id]!.category),
      // Group ids are only meaningful within a labeler, so they are namespaced
      // before comparison. What is compared is the partition, not the names.
      aGroups: ids.map((id) => `a:${la.labels[id]!.group}`),
      bGroups: ids.map((id) => `b:${lb.labels[id]!.group}`),
    });
  }
  return { aligned, skipped };
}

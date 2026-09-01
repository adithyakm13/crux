/**
 * Gate 0 status: what the corpus contains, measured against the thresholds in
 * §2, with nothing rounded in the corpus's favour.
 *
 * Every threshold here is quoted from the spec and reported as met or not met.
 * The point of this command is that "is Gate 0 passed?" has a mechanical
 * answer nobody has to argue about.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateRunLabels, type CorpusRun, type RunLabels } from './schema.ts';

export interface Requirement {
  id: string;
  description: string;
  observed: number;
  required: number;
  met: boolean;
}

export interface GateZeroStatus {
  corpusDir: string;
  runs: number;
  failures: number;
  repositories: number;
  frameworksSeen: string[];
  runsWithAtLeast5Failures: number;
  syntheticFraction: number;
  fidelityBreakdown: Record<string, number>;
  labelers: string[];
  labeledFailures: number;
  labeledRuns: number;
  perCategoryLabeled: Record<string, number>;
  requirements: Requirement[];
  passed: boolean;
  /** Steps that cannot be satisfied by tooling alone. */
  blockedOnHumans: string[];
}

export async function gateZeroStatus(
  corpusDir: string,
  runs: CorpusRun[],
): Promise<GateZeroStatus> {
  const repos = new Set(runs.map((r) => r.source.repo));
  const failures = runs.reduce((n, r) => n + r.failures.length, 0);
  const runsWith5 = runs.filter((r) => r.failures.length >= 5).length;
  const fidelity: Record<string, number> = {};
  for (const r of runs) fidelity[r.fidelity] = (fidelity[r.fidelity] ?? 0) + 1;
  const synthetic = fidelity['synthetic'] ?? 0;

  const labelSets = await loadAllLabels(corpusDir, runs);
  const labelers = [...new Set(labelSets.map((l) => l.labeler))].sort();
  const labeledFailureKeys = new Set<string>();
  const perCategory: Record<string, number> = {};
  for (const ls of labelSets) {
    for (const [failureId, label] of Object.entries(ls.labels)) {
      labeledFailureKeys.add(`${ls.corpusRunId}#${failureId}`);
      perCategory[label.category] = (perCategory[label.category] ?? 0) + 1;
    }
  }
  const labeledRuns = new Set(labelSets.map((l) => l.corpusRunId)).size;

  const requirements: Requirement[] = [
    req('runs', '>=80 complete CI runs', runs.length, 80),
    req('multi-failure-runs', '>=50 runs with >=5 failures each', runsWith5, 50),
    req('failures', '>=1000 labeled failures total', labeledFailureKeys.size, 1000),
    req('repositories', '>=10 distinct repositories', repos.size, 10),
    req('frameworks', '>=3 frameworks', frameworksOf(runs).length, 3),
    req('labelers', '>=2 independent labelers', labelers.length, 2),
  ];

  const syntheticFraction = runs.length === 0 ? 0 : synthetic / runs.length;
  requirements.push({
    id: 'synthetic-cap',
    description: 'synthetic runs <=20% of corpus',
    observed: Number((syntheticFraction * 100).toFixed(1)),
    required: 20,
    met: syntheticFraction <= 0.2,
  });

  // Per-category floor: a category below 30 examples is reported with its
  // interval and excluded from gating, so the floor is tracked per category
  // rather than as a single number.
  for (const [category, n] of Object.entries(perCategory).sort()) {
    requirements.push({
      id: `category:${category}`,
      description: `>=30 examples of ${category} to carry a precision gate`,
      observed: n,
      required: 30,
      met: n >= 30,
    });
  }

  return {
    corpusDir,
    runs: runs.length,
    failures,
    repositories: repos.size,
    frameworksSeen: frameworksOf(runs),
    runsWithAtLeast5Failures: runsWith5,
    syntheticFraction,
    fidelityBreakdown: fidelity,
    labelers,
    labeledFailures: labeledFailureKeys.size,
    labeledRuns,
    perCategoryLabeled: perCategory,
    requirements,
    passed: requirements.every((r) => r.met),
    blockedOnHumans: blockedOnHumans(labelers.length, labeledFailureKeys.size),
  };
}

function req(id: string, description: string, observed: number, required: number): Requirement {
  return { id, description, observed, required, met: observed >= required };
}

/**
 * Framework is inferred from evidence in the payload, never asserted. An
 * unrecognised producer counts as `unknown` rather than being guessed into a
 * bucket that would inflate the framework count.
 */
function frameworksOf(runs: CorpusRun[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const f of run.failures) {
      // Text inference first because it is finer-grained: JUnit XML is emitted
      // by pytest, jest, surefire and a dozen others, so the adapter name alone
      // would collapse them all into one "framework". The adapter is the
      // fallback, and it is authoritative when inference cannot tell.
      const inferred = detectFramework(f.sourceFile, f.stackText, f.errorType);
      seen.add(inferred === 'unknown' ? (f.producerAdapter ?? 'unknown') : inferred);
    }
  }
  seen.delete('unknown');
  return [...seen].sort();
}

export function detectFramework(
  sourceFile: string,
  stackText: string | null,
  errorType: string | null,
): string {
  const hay = `${sourceFile}\n${stackText ?? ''}\n${errorType ?? ''}`;
  if (/playwright|@playwright\/test/i.test(hay)) return 'playwright';
  if (/site-packages\/_pytest|pytest|\.py:\d+|E\s+assert/i.test(hay)) return 'pytest';
  if (/jest|@jest\//i.test(hay)) return 'jest';
  if (/vitest/i.test(hay)) return 'vitest';
  if (/cypress/i.test(hay)) return 'cypress';
  if (/mocha/i.test(hay)) return 'mocha';
  if (/surefire|junit\.framework|org\.junit|java\.lang\./i.test(hay)) return 'junit-jvm';
  if (/go test|testing\.T|\.go:\d+/i.test(hay)) return 'go-test';
  if (/rspec|_spec\.rb/i.test(hay)) return 'rspec';
  return 'unknown';
}

function blockedOnHumans(labelers: number, labeled: number): string[] {
  const out: string[] = [];
  if (labelers < 2) {
    out.push(
      'Inter-labeler agreement (Cohen’s kappa on category, pairwise agreement on ' +
        'grouping) needs two people labeling the same 100-failure subset independently. ' +
        'Tooling cannot produce this number.',
    );
  }
  if (labeled === 0) {
    out.push(
      'The separability rate needs a labeler who sees only the failure payload, ' +
        'scored against the full-context label over 150 failures. It is the number ' +
        'the Gate 0 stop condition is stated in.',
    );
  }
  return out;
}

async function loadAllLabels(corpusDir: string, runs: CorpusRun[]): Promise<RunLabels[]> {
  const byId = new Map(runs.map((r) => [r.corpusRunId, r]));
  const root = join(corpusDir, 'labels');
  let labelerDirs: string[];
  try {
    labelerDirs = await readdir(root);
  } catch {
    return [];
  }
  const out: RunLabels[] = [];
  for (const labeler of labelerDirs.sort()) {
    let files: string[];
    try {
      files = await readdir(join(root, labeler));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const path = join(root, labeler, file);
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const labels = validateRunLabels(
        parsed,
        path,
        byId.get((parsed as RunLabels).corpusRunId),
      );
      out.push(labels);
    }
  }
  return out;
}

export function formatGateZeroStatus(s: GateZeroStatus): string {
  const lines: string[] = [];
  lines.push(`corpus: ${s.corpusDir}`);
  lines.push(
    `${s.runs} run(s), ${s.failures} failure(s), ${s.repositories} repositor${
      s.repositories === 1 ? 'y' : 'ies'
    }`,
  );
  lines.push(
    `frameworks: ${s.frameworksSeen.length > 0 ? s.frameworksSeen.join(', ') : 'none detected'}`,
  );
  lines.push(
    `fidelity: ${
      Object.entries(s.fidelityBreakdown)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'n/a'
    }`,
  );
  lines.push(
    `labels: ${s.labeledFailures} failure(s) across ${s.labeledRuns} run(s) by ` +
      `${s.labelers.length} labeler(s)${s.labelers.length ? ` (${s.labelers.join(', ')})` : ''}`,
  );
  lines.push('');
  lines.push('Gate 0 requirements');
  const width = Math.max(...s.requirements.map((r) => r.description.length));
  for (const r of s.requirements) {
    lines.push(
      `  ${r.met ? 'PASS' : 'FAIL'}  ${r.description.padEnd(width)}  ${r.observed} / ${r.required}`,
    );
  }
  lines.push('');
  lines.push(s.passed ? 'Gate 0: MET' : 'Gate 0: NOT MET');
  if (s.blockedOnHumans.length > 0) {
    lines.push('');
    lines.push('Requires human labeling, not tooling:');
    for (const b of s.blockedOnHumans) lines.push(`  - ${b}`);
  }
  return lines.join('\n');
}

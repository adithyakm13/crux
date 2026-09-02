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
import { alignLabelers } from './label.ts';
import { bootstrapProportion, pairwiseAgreement } from '@cruxci/core';

export interface Requirement {
  id: string;
  description: string;
  observed: number;
  required: number;
  met: boolean;
  /**
   * Why a requirement could not be measured. Present only when `observed` is
   * NaN. An unmeasurable gate is reported as NOT met with a reason, never
   * omitted — an omitted row reads as a gate that passed.
   */
  note?: string;
}

export interface GateZeroStatus {
  corpusDir: string;
  runs: number;
  failures: number;
  repositories: number;
  frameworksSeen: string[];
  /** Failures whose producing framework could not be identified from evidence. */
  unidentifiedFrameworkFailures: number;
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
  // Distinct failures per category, not label rows. Counting rows double-counts
  // every failure that two labelers both labeled — and Gate 0 requires two
  // labelers — so a 30-example floor would pass on 15 real failures. The header
  // promises nothing is rounded in the corpus's favour; this is that promise.
  const perCategoryKeys: Record<string, Set<string>> = {};
  for (const ls of labelSets) {
    for (const [failureId, label] of Object.entries(ls.labels)) {
      const key = `${ls.corpusRunId}#${failureId}`;
      labeledFailureKeys.add(key);
      (perCategoryKeys[label.category] ??= new Set()).add(key);
    }
  }
  // A failure the two labelers put in different categories counts toward both.
  // That is deliberate: the floor asks how many examples of a category exist to
  // gate precision on, and a disputed example is a real example of each — the
  // disagreement itself is reported by `corpus agreement`.
  const perCategory: Record<string, number> = {};
  for (const [category, keys] of Object.entries(perCategoryKeys)) {
    perCategory[category] = keys.size;
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

  // The two measurements the Phase 0 gate is actually stated in. Counting runs
  // and labels is necessary but not sufficient: without these, `status` could
  // print "Gate 0: MET" while the payload-only thesis had never been tested,
  // and Phase 1 would start on a gate that was never evaluated.
  //
  // Both are unmeasurable until the labeling exists, and an unmeasured gate is
  // a FAILED gate, never an omitted row. Both are evaluated on the LOWER bound.
  const measured = await measuredGates(corpusDir, runs, labelSets);
  requirements.push(measured.agreement, measured.separability);

  return {
    corpusDir,
    runs: runs.length,
    failures,
    repositories: repos.size,
    frameworksSeen: frameworksOf(runs),
    unidentifiedFrameworkFailures: unidentifiedCount(runs),
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
 * Adapters whose name identifies a framework rather than a file format.
 *
 * Only Playwright qualifies: the blob report is Playwright-specific, so the
 * adapter having parsed it *is* evidence. `junit` is a format emitted by
 * pytest, jest, vitest, surefire and a dozen others — counting it as a
 * framework inflates the Gate 0 framework count with a name that identifies
 * nothing.
 */
const FRAMEWORK_IDENTIFYING_ADAPTERS = new Set(['playwright']);

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
      if (inferred !== 'unknown') {
        seen.add(inferred);
        continue;
      }
      const adapter = f.producerAdapter;
      seen.add(
        adapter !== undefined && FRAMEWORK_IDENTIFYING_ADAPTERS.has(adapter) ? adapter : 'unknown',
      );
    }
  }
  seen.delete('unknown');
  return [...seen].sort();
}

function unidentifiedCount(runs: CorpusRun[]): number {
  let n = 0;
  for (const run of runs) {
    for (const f of run.failures) {
      if (detectFramework(f.sourceFile, f.stackText, f.errorType) !== 'unknown') continue;
      const adapter = f.producerAdapter;
      if (adapter !== undefined && FRAMEWORK_IDENTIFYING_ADAPTERS.has(adapter)) continue;
      n++;
    }
  }
  return n;
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
  // The heavy arrow is Vitest's stack-frame marker; nothing else emits it, and
  // a Vitest run reaches crux as ordinary JUnit XML with no other tell.
  if (/vitest/i.test(hay) || /\u276f\s+\S+:\d+:\d+/.test(hay)) return 'vitest';
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
    `frameworks: ${s.frameworksSeen.length > 0 ? s.frameworksSeen.join(', ') : 'none detected'}` +
      (s.unidentifiedFrameworkFailures > 0
        ? `  (+${s.unidentifiedFrameworkFailures} failure(s) of unidentified framework)`
        : ''),
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
      `  ${r.met ? 'PASS' : 'FAIL'}  ${r.description.padEnd(width)}  ` +
        (Number.isFinite(r.observed)
          ? `${r.observed} / ${r.required}`
          : `not measured / ${r.required}${r.note ? ` — ${r.note}` : ''}`),
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

/**
 * The two Phase 0 gates that are measurements rather than counts: grouping
 * agreement between two labelers, and the separability rate.
 *
 * Both are evaluated on the LOWER bound of a 95% interval, and both report
 * `met: false` with a note when there is not yet enough labeling to measure
 * them. That asymmetry is deliberate: an unevaluated stop condition is not a
 * satisfied stop condition, and `status` is the command Phase 1 is gated on.
 */
async function measuredGates(
  corpusDir: string,
  runs: CorpusRun[],
  labelSets: RunLabels[],
): Promise<{ agreement: Requirement; separability: Requirement }> {
  const unmeasured = (id: string, description: string, required: number, note: string) => ({
    id,
    description,
    observed: NaN,
    required,
    met: false,
    note,
  });

  const byLabeler = new Map<string, Map<string, RunLabels>>();
  const contextOf = new Map<string, Set<string>>();
  for (const ls of labelSets) {
    let m = byLabeler.get(ls.labeler);
    if (m === undefined) {
      m = new Map();
      byLabeler.set(ls.labeler, m);
    }
    m.set(ls.corpusRunId, ls);
    (contextOf.get(ls.labeler) ?? contextOf.set(ls.labeler, new Set()).get(ls.labeler)!).add(
      ls.context,
    );
  }
  const names = [...byLabeler.keys()].sort();

  // --- grouping agreement -------------------------------------------------
  let agreement: Requirement = unmeasured(
    'grouping-agreement',
    'grouping agreement >=0.80 (lower bound), two labelers',
    0.8,
    'needs two labelers with overlapping labeled runs',
  );
  let best: { lower: number; pair: string; runs: number } | null = null;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const { aligned } = alignLabelers(runs, byLabeler.get(names[i]!)!, byLabeler.get(names[j]!)!);
      if (aligned.length === 0) continue;
      const r = pairwiseAgreement(aligned.map((x) => ({ a: x.aGroups, b: x.bGroups })));
      if (!Number.isFinite(r.agreement.lower)) continue;
      // Report the weakest pair, not the strongest: if any pair of labelers
      // disagrees, the task is ambiguous as specified for everyone.
      if (best === null || r.agreement.lower < best.lower) {
        best = { lower: r.agreement.lower, pair: `${names[i]} vs ${names[j]}`, runs: r.runs };
      }
    }
  }
  if (best !== null) {
    agreement = {
      id: 'grouping-agreement',
      description: `grouping agreement >=0.80 (lower bound, ${best.pair})`,
      observed: Number(best.lower.toFixed(3)),
      required: 0.8,
      met: best.lower >= 0.8,
    };
  }

  // --- separability -------------------------------------------------------
  const fullOnly = names.filter(
    (n) => contextOf.get(n)!.has('full') && !contextOf.get(n)!.has('payload-only'),
  );
  const payloadOnly = names.filter(
    (n) => contextOf.get(n)!.has('payload-only') && !contextOf.get(n)!.has('full'),
  );
  let separability: Requirement = unmeasured(
    'separability',
    'separability >=0.60 (lower bound)',
    0.6,
    payloadOnly.length === 0
      ? 'needs a labeler working in payload-only context'
      : 'needs a full-context labeler covering the same runs',
  );
  let sepBest: { lower: number; pair: string } | null = null;
  for (const f of fullOnly) {
    for (const p of payloadOnly) {
      const { aligned } = alignLabelers(runs, byLabeler.get(f)!, byLabeler.get(p)!);
      const perRun = aligned.map((x) => ({
        successes: x.aCategories.filter((v, i) => v === x.bCategories[i]).length,
        total: x.aCategories.length,
      }));
      if (perRun.length === 0) continue;
      const iv = bootstrapProportion(perRun);
      if (!Number.isFinite(iv.lower)) continue;
      if (sepBest === null || iv.lower < sepBest.lower) {
        sepBest = { lower: iv.lower, pair: `${f} (full) vs ${p} (payload-only)` };
      }
    }
  }
  if (sepBest !== null) {
    separability = {
      id: 'separability',
      description: `separability >=0.60 (lower bound, ${sepBest.pair})`,
      observed: Number(sepBest.lower.toFixed(3)),
      required: 0.6,
      met: sepBest.lower >= 0.6,
    };
  }

  return { agreement, separability };
}

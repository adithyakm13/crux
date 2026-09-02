/**
 * Gate 0 commands beyond harvesting: labeling, agreement, separability and the
 * baseline spike.
 *
 * These are separated from `cli.ts` so each is callable from a test without
 * going through argument parsing.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  cohensKappa,
  pairwiseAgreement,
  wilson,
  type Interval,
  type KappaResult,
  bootstrapProportion,
} from '@cruxci/core';
import { loadRuns } from './harvest.ts';
import {
  alignLabelers,
  categoryByOrdinal,
  emptyLabels,
  loadLabels,
  renderCategoryMenu,
  renderFailure,
  renderRunHeader,
  saveLabels,
  type LabelContext,
} from './label.ts';
import type { CorpusRun, RunLabels } from './schema.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateRunLabels } from './schema.ts';

// ---------------------------------------------------------------------------
// label
// ---------------------------------------------------------------------------

export interface LabelCommandOptions {
  corpusDir: string;
  labeler: string;
  context: LabelContext;
  /** Label at most this many runs in one sitting. */
  maxRuns?: number;
  /** Only runs with at least this many failures; these carry the pair metric. */
  minFailures?: number;
  /** Deterministic subset selection, so a second labeler can be given the same one. */
  only?: string[];
}

export async function labelCommand(options: LabelCommandOptions): Promise<number> {
  const runs = await loadRuns(options.corpusDir);
  if (runs.length === 0) {
    stdout.write(`No runs in ${options.corpusDir}. Run \`corpus harvest\` first.\n`);
    return 2;
  }
  const minFailures = options.minFailures ?? 1;
  const selected = runs
    .filter((r) => r.failures.length >= minFailures)
    .filter((r) => options.only === undefined || options.only.includes(r.corpusRunId));

  if (selected.length === 0) {
    stdout.write(`No run has >= ${minFailures} failures. Nothing to label.\n`);
    return 2;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  let labelled = 0;
  let runsTouched = 0;
  try {
    for (const run of selected) {
      if (options.maxRuns !== undefined && runsTouched >= options.maxRuns) break;
      const existing = await loadLabels(options.corpusDir, options.labeler, run);
      const labels: RunLabels =
        existing ?? emptyLabels(run.corpusRunId, options.labeler, options.context);
      if (existing !== null && existing.context !== options.context) {
        // Mixing contexts inside one file would make the separability number
        // uninterpretable: you could no longer say what the labeler could see.
        stdout.write(
          `\nSkipping ${run.corpusRunId}: already labelled in "${existing.context}" context, ` +
            `you asked for "${options.context}". Use a different --labeler for the other context.\n`,
        );
        continue;
      }
      const todo = run.failures.filter((f) => labels.labels[f.failureId] === undefined);
      if (todo.length === 0) continue;

      runsTouched++;
      stdout.write(`\n${'='.repeat(72)}\n`);
      stdout.write(renderRunHeader(run, { context: options.context }) + '\n');
      stdout.write(
        `\nGroup failures that share ONE root cause by giving them the same group id.\n` +
          `A failure with a cause of its own is its own group. Enter "?" for the menu,\n` +
          `"s" to skip a failure, "q" to save and stop.\n`,
      );

      for (const [i, failure] of todo.entries()) {
        stdout.write(`\n${'-'.repeat(72)}\n`);
        stdout.write(renderFailure(failure, i, todo.length, { context: options.context }) + '\n\n');

        // Groups are chosen by NUMBER, not retyped by name.
        //
        // The group id is the grouping ground truth. Typing it freehand once per
        // failure means a single typo silently invents a group, which shows up
        // later as a clustering disagreement that no reviewer can distinguish
        // from a real one. Reuse-by-index removes that failure mode, and over
        // sixty-odd failures it also removes most of the typing.
        const usedGroups = [...new Set(Object.values(labels.labels).map((l) => l.group))];
        if (usedGroups.length > 0) {
          stdout.write(
            `groups so far:  ` +
              usedGroups.map((g, gi) => `${gi + 1}) ${g}`).join('   ') +
              `\n`,
          );
        }

        let groupAnswer: string | null = null;
        while (groupAnswer === null) {
          const raw = (
            await rl.question('group [number reuses, n=new, name, s=skip, q=quit]: ')
          ).trim();

          if (raw === 'q') {
            await saveLabels(options.corpusDir, labels);
            stdout.write(`Saved ${labelled} label(s).\n`);
            return 0;
          }
          if (raw === 's') break;
          if (raw === '') {
            // Never a silent skip. An accidental Enter in a long session used to
            // drop the failure with no indication it had happened.
            stdout.write('Enter a group, or "s" to skip this failure deliberately.\n');
            continue;
          }
          if (raw === 'n') {
            groupAnswer = `g${usedGroups.length + 1}`;
            stdout.write(`  new group ${groupAnswer}\n`);
            break;
          }
          if (/^\d+$/.test(raw)) {
            const idx = Number(raw);
            if (idx >= 1 && idx <= usedGroups.length) {
              groupAnswer = usedGroups[idx - 1]!;
              stdout.write(`  reusing ${groupAnswer}\n`);
              break;
            }
            stdout.write(
              `No group ${idx}. There ${usedGroups.length === 1 ? 'is' : 'are'} ` +
                `${usedGroups.length}. Enter "n" for a new one.\n`,
            );
            continue;
          }
          groupAnswer = raw;
        }
        if (groupAnswer === null) continue; // 's'

        let category = null;
        while (category === null) {
          const answer = await rl.question('category (number, name, or ? for menu): ');
          if (answer.trim() === '?') {
            stdout.write(renderCategoryMenu() + '\n');
            continue;
          }
          category = categoryByOrdinal(answer);
          if (category === null) stdout.write('Not a category. Enter ? for the menu.\n');
        }
        const note = (await rl.question('note (optional): ')).trim();
        labels.labels[failure.failureId] = {
          group: groupAnswer,
          category,
          ...(note === '' ? {} : { note }),
        };
        labelled++;
      }
      labels.labeledAt = new Date().toISOString();
      await saveLabels(options.corpusDir, labels);
    }
  } finally {
    rl.close();
  }
  stdout.write(`\nSaved ${labelled} label(s) across ${runsTouched} run(s).\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// agreement
// ---------------------------------------------------------------------------

export interface AgreementReport {
  labelerA: string;
  labelerB: string;
  runsCompared: number;
  failuresCompared: number;
  skipped: { corpusRunId: string; reason: string }[];
  categoryKappa: KappaResult;
  categoryAgreement: Interval;
  groupingPairwiseAgreement: Interval;
  pairsCompared: number;
  /** §2: below 0.80 pairwise agreement the task is ambiguous. */
  taskIsAmbiguous: boolean;
}

export async function agreementReport(
  corpusDir: string,
  labelerA: string,
  labelerB: string,
): Promise<AgreementReport> {
  const runs = await loadRuns(corpusDir);
  const a = await loadLabelerIndex(corpusDir, labelerA, runs);
  const b = await loadLabelerIndex(corpusDir, labelerB, runs);
  const { aligned, skipped } = alignLabelers(runs, a, b);

  const allA = aligned.flatMap((x) => x.aCategories);
  const allB = aligned.flatMap((x) => x.bCategories);
  const categoryKappa = cohensKappa(allA, allB);
  const agreedCategories = allA.filter((v, i) => v === allB[i]).length;
  const grouping = pairwiseAgreement(
    aligned.map((x) => ({ a: x.aGroups, b: x.bGroups })),
  );

  return {
    labelerA,
    labelerB,
    runsCompared: aligned.length,
    failuresCompared: allA.length,
    skipped,
    categoryKappa,
    // Same correlation argument as the grouping interval above.
    categoryAgreement: bootstrapProportion(
      aligned.map((x) => ({
        successes: x.aCategories.filter((v, i) => v === x.bCategories[i]).length,
        total: x.aCategories.length,
      })),
    ),
    groupingPairwiseAgreement: grouping.agreement,
    pairsCompared: grouping.pairs,
    taskIsAmbiguous:
      Number.isFinite(grouping.agreement.lower) && grouping.agreement.lower < 0.8,
  };
}

export function formatAgreement(r: AgreementReport): string {
  const n = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
  const lines: string[] = [];
  lines.push(`labelers: ${r.labelerA} vs ${r.labelerB}`);
  lines.push(`compared ${r.failuresCompared} failure(s) across ${r.runsCompared} run(s)`);
  if (r.skipped.length > 0) lines.push(`skipped ${r.skipped.length} run(s) neither pair covered`);
  lines.push('');
  lines.push(`category Cohen's kappa      ${n(r.categoryKappa.kappa)}`);
  lines.push(
    `category raw agreement      ${n(r.categoryAgreement.point)} ` +
      `[${n(r.categoryAgreement.lower)}, ${n(r.categoryAgreement.upper)}]`,
  );
  lines.push(
    `grouping pairwise agreement ${n(r.groupingPairwiseAgreement.point)} ` +
      `[${n(r.groupingPairwiseAgreement.lower)}, ${n(r.groupingPairwiseAgreement.upper)}] ` +
      `over ${r.pairsCompared} pair(s)`,
  );
  lines.push('');
  if (r.failuresCompared === 0) {
    lines.push('No overlap: these two labelers have not labelled the same failures yet.');
  } else if (r.taskIsAmbiguous) {
    lines.push(
      'Grouping agreement is below 0.80 at the lower bound. Per §2 the task is ' +
        'ambiguous as specified, and every downstream target needs revisiting ' +
        'before it is chased. Human agreement is the ceiling: a model scoring ' +
        'above it is overfitting the labeler.',
    );
  } else {
    lines.push('Grouping agreement clears 0.80 at the lower bound; the task is well posed.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// separability
// ---------------------------------------------------------------------------

export interface SeparabilityReport {
  fullContextLabeler: string;
  payloadOnlyLabeler: string;
  compared: number;
  agreed: number;
  rate: Interval;
  /** §2 stop condition: upper bound below 0.60 falsifies the payload-only thesis. */
  thesisFalsified: boolean;
  perCategory: Record<string, { n: number; agreed: number }>;
}

export async function separabilityReport(
  corpusDir: string,
  fullContextLabeler: string,
  payloadOnlyLabeler: string,
): Promise<SeparabilityReport> {
  const runs = await loadRuns(corpusDir);
  const full = await loadLabelerIndex(corpusDir, fullContextLabeler, runs);
  const payload = await loadLabelerIndex(corpusDir, payloadOnlyLabeler, runs);

  // Both sides are checked. Validating only the payload-only labeler let two
  // payload-only labelers be scored against each other and reported as a
  // separability rate — which is not that quantity at all: it is inter-labeler
  // agreement under the restricted condition, and it would read as evidence for
  // the payload-only thesis while containing none.
  for (const [id, labels] of payload) {
    if (labels.context !== 'payload-only') {
      throw new Error(
        `${payloadOnlyLabeler} labelled ${id} with context "${labels.context}", not ` +
          `"payload-only". The separability rate is defined only over payload-only ` +
          `labels; scoring full-context labels as payload-only would fabricate the number.`,
      );
    }
  }
  for (const [id, labels] of full) {
    if (labels.context !== 'full') {
      throw new Error(
        `${fullContextLabeler} labelled ${id} with context "${labels.context}", not ` +
          `"full". Separability is agreement between a full-context label and a ` +
          `payload-only one; comparing two payload-only labelers measures agreement ` +
          `under the restricted condition, not separability.`,
      );
    }
  }

  const { aligned } = alignLabelers(runs, full, payload);
  let compared = 0;
  let agreed = 0;
  const perCategory: Record<string, { n: number; agreed: number }> = {};
  for (const row of aligned) {
    for (const [i, truth] of row.aCategories.entries()) {
      const guess = row.bCategories[i]!;
      compared++;
      perCategory[truth] ??= { n: 0, agreed: 0 };
      perCategory[truth]!.n++;
      if (truth === guess) {
        agreed++;
        perCategory[truth]!.agreed++;
      }
    }
  }
  // Bootstrap over runs, not a pooled Wilson: failures inside a run share the
  // build, the labelers and the root causes, so pooling them asserts an
  // independence that does not hold and narrows the interval.
  const rate = bootstrapProportion(
    aligned.map((row) => ({
      successes: row.aCategories.filter((v, i) => v === row.bCategories[i]).length,
      total: row.aCategories.length,
    })),
  );
  return {
    fullContextLabeler,
    payloadOnlyLabeler,
    compared,
    agreed,
    rate,
    thesisFalsified: compared > 0 && rate.upper < 0.6,
    perCategory,
  };
}

export function formatSeparability(r: SeparabilityReport): string {
  const n = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
  const lines: string[] = [];
  lines.push(`full context: ${r.fullContextLabeler}   payload only: ${r.payloadOnlyLabeler}`);
  lines.push(`agreed on ${r.agreed} of ${r.compared} failure(s)`);
  lines.push(
    `separability rate ${n(r.rate.point)} [${n(r.rate.lower)}, ${n(r.rate.upper)}] (Wilson 95%)`,
  );
  if (r.compared < 150) {
    lines.push(
      `NOTE: §2 specifies a 150-failure sample; this is ${r.compared}. ` +
        `The interval is reported as computed and is wide accordingly.`,
    );
  }
  lines.push('');
  lines.push('per full-context category:');
  for (const [category, v] of Object.entries(r.perCategory).sort()) {
    lines.push(`  ${category.padEnd(23)} ${v.agreed}/${v.n}`);
  }
  lines.push('');
  if (r.compared === 0) {
    lines.push('No overlap yet — nothing can be concluded.');
  } else if (r.thesisFalsified) {
    lines.push(
      'STOP CONDITION MET: the Wilson upper bound is below 0.60. Per §2 the ' +
        'payload-only thesis is wrong. Report it and stop; do not build around ' +
        'a negative result.',
    );
  } else if (r.rate.lower >= 0.6) {
    lines.push('Gate 0 separability threshold is cleared at the lower bound.');
  } else {
    lines.push(
      'Inconclusive: the interval spans 0.60. More labelled failures are needed ' +
        'before this either clears or falsifies the thesis.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

export async function loadLabelerIndex(
  corpusDir: string,
  labeler: string,
  runs: readonly CorpusRun[],
): Promise<Map<string, RunLabels>> {
  const byId = new Map(runs.map((r) => [r.corpusRunId, r]));
  const dir = join(corpusDir, 'labels', labeler.replace(/[^A-Za-z0-9._-]+/g, '_'));
  const out = new Map<string, RunLabels>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return out;
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as RunLabels;
    const labels = validateRunLabels(parsed, path, byId.get(parsed.corpusRunId));
    out.set(labels.corpusRunId, labels);
  }
  return out;
}

export async function listLabelers(corpusDir: string): Promise<string[]> {
  try {
    return (await readdir(join(corpusDir, 'labels'))).sort();
  } catch {
    return [];
  }
}

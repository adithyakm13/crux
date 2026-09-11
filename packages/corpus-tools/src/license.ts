/**
 * Which harvested runs may be committed.
 *
 * The corpus lives in git, and git is a distribution channel. Two categories
 * are kept on disk and out of version control:
 *
 *  1. Unidentified licence. GitHub reports NOASSERTION for a LICENSE file it
 *     cannot classify, which is not the same as having no licence, and neither
 *     is a basis for redistribution.
 *  2. Copyleft — GPL/LGPL/AGPL. crux itself is Apache-2.0. The stored payload
 *     is failure messages and stack traces, arguably factual CI output rather
 *     than licensed expression, but "arguably" is not a basis for putting it
 *     in git history.
 *
 * The consequence has to be reported, not just enforced. A held-out run is
 * present for every number computed on this machine and absent from every
 * number computed on a fresh clone, so any gate figure that does not say which
 * set it was computed over is not reproducible. `corpus status` reports both.
 */

import type { CorpusRun } from './schema.ts';

/** SPDX identifiers whose reciprocal terms put redistribution in question. */
const COPYLEFT = /^(?:A?GPL|LGPL|GPL|EUPL|OSL|CECILL|SSPL|CPAL)(?:-|$)/i;

export type HoldOutReason = { kind: 'unidentified' | 'copyleft'; detail: string };

/** Null when the run may be committed. */
export function holdOutReason(run: CorpusRun): HoldOutReason | null {
  const spdx = run.source.licenseSpdx;
  if (spdx === null || spdx === 'NOASSERTION') {
    return { kind: 'unidentified', detail: run.source.licenseRaw ?? 'none' };
  }
  if (COPYLEFT.test(spdx)) {
    return { kind: 'copyleft', detail: spdx };
  }
  return null;
}

export function isHeldOut(run: CorpusRun): boolean {
  return holdOutReason(run) !== null;
}

export interface HoldOutEntry {
  dir: string;
  repo: string;
  license: string;
  reason: HoldOutReason;
  failures: number;
}

/** Marks the block `corpus holdout --write` owns. Edits outside it survive. */
export const HOLDOUT_BEGIN = '# >>> corpus holdout (generated — do not edit by hand) >>>';
export const HOLDOUT_END = '# <<< corpus holdout <<<';

/**
 * Replace the managed block, or append one if absent.
 *
 * Hand-written rules elsewhere in the file are left alone: the licence list is
 * regenerated after every harvest, and a generator that owned the whole file
 * would silently discard them.
 */
export function renderGitignore(existing: string, paths: readonly string[]): string {
  const block = [
    HOLDOUT_BEGIN,
    '# Runs held out of version control: copyleft, or a licence GitHub could not',
    '# identify. Present on disk and usable locally; absent from a fresh clone.',
    '# Regenerate with `corpus holdout --write`. Force-add one to override:',
    '#   git add -f corpus/runs/<dir>',
    ...[...paths].sort(),
    HOLDOUT_END,
  ].join('\n');

  const start = existing.indexOf(HOLDOUT_BEGIN);
  const end = existing.indexOf(HOLDOUT_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + HOLDOUT_END.length);
  }
  return existing.replace(/\n*$/, '\n\n') + block + '\n';
}

export function formatHoldOut(entries: readonly HoldOutEntry[], totalRuns: number): string {
  if (entries.length === 0) {
    return `no runs held out; all ${totalRuns} are committable\n`;
  }
  const byRepo = new Map<string, { runs: number; failures: number; license: string }>();
  for (const e of entries) {
    const row = byRepo.get(e.repo) ?? { runs: 0, failures: 0, license: e.license };
    row.runs++;
    row.failures += e.failures;
    byRepo.set(e.repo, row);
  }
  const lines = [
    `held out: ${entries.length} run(s) across ${byRepo.size} repositories`,
    `committable: ${totalRuns - entries.length} of ${totalRuns} run(s)`,
    '',
    'runs  fails  licence          repository',
  ];
  for (const [repo, v] of [...byRepo].sort((a, b) => b[1].runs - a[1].runs)) {
    lines.push(
      `${String(v.runs).padStart(4)}${String(v.failures).padStart(7)}  ` +
        `${v.license.padEnd(15)}  ${repo}`,
    );
  }
  return lines.join('\n') + '\n';
}

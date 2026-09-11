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

export type HoldOutReason = {
  kind: 'unidentified' | 'copyleft' | 'oversized';
  detail: string;
};

/**
 * GitHub hard-rejects a file over 100 MB and warns over 50 MB. The margin is
 * deliberate: a run file is rewritten by `corpus compact` and re-read by every
 * tool here, and a repository carrying tens of megabytes of JSON per run is
 * unpleasant to clone long before git refuses it.
 *
 * This is a redistribution limit, NOT a judgement about the run's value. The
 * separate problem — that a 1549-failure run contributes 1.2 million pairs and
 * swamps every other run in the clustering metric — is not solved by excluding
 * it from git, because the run is still on disk and still counted locally.
 * That one is handled where it belongs, by `--max-failures` when sampling for
 * labelling, and by the per-run F1 table that makes one run's dominance
 * visible.
 */
export const MAX_COMMITTABLE_RUN_BYTES = 50 * 1024 * 1024;

/** Null when the run may be committed. `bytes` is the run.json size on disk. */
export function holdOutReason(
  run: CorpusRun,
  bytes?: number,
  maxBytes: number = MAX_COMMITTABLE_RUN_BYTES,
): HoldOutReason | null {
  if (bytes !== undefined && bytes > maxBytes) {
    return {
      kind: 'oversized',
      detail: `${(bytes / 1048576).toFixed(1)} MB run.json, over the ${(maxBytes / 1048576).toFixed(0)} MB limit`,
    };
  }
  const spdx = run.source.licenseSpdx;
  if (spdx === null || spdx === 'NOASSERTION') {
    return { kind: 'unidentified', detail: run.source.licenseRaw ?? 'none' };
  }
  if (COPYLEFT.test(spdx)) {
    return { kind: 'copyleft', detail: spdx };
  }
  return null;
}

export function isHeldOut(run: CorpusRun, bytes?: number): boolean {
  return holdOutReason(run, bytes) !== null;
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
  const byKind = new Map<string, number>();
  for (const e of entries) byKind.set(e.reason.kind, (byKind.get(e.reason.kind) ?? 0) + 1);
  const lines = [
    `held out: ${entries.length} run(s) across ${byRepo.size} repositories ` +
      `(${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ')})`,
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

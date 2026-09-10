/**
 * The labelling ledger: a worksheet rendered as a single self-contained page.
 *
 * Why this exists alongside the JSON worksheet. Editing 156 entries by hand in
 * a JSON file works, but it puts the labeller one stray comma away from a file
 * that will not import, and it gives them no way to see the taxonomy they are
 * building. Group reuse is the whole game — a group name that should have been
 * reused but was retyped slightly differently is a silent split, and splits are
 * what pairwise F1 measures. The page shows every name already used, run-local
 * ones first, so reuse is a click rather than a recall.
 *
 * Contamination rules carry over unchanged, because the page is built FROM a
 * worksheet rather than from the corpus:
 *  - a payload-only worksheet produces a payload-only page. Nothing here can
 *    add provenance back, because nothing here has it.
 *  - `context` travels into the page and back out of the export, so the swap
 *    that would quietly void the separability rate is still impossible.
 *  - no machine label and no other labeller's answers are ever embedded. An
 *    anchored second pass measures agreement with the anchor, not with the
 *    labeller.
 *
 * The output is one HTML file with no build step and no network dependency
 * beyond a webfont. Published as an Artifact it also persists labels; opened
 * from disk it keeps them in localStorage and exports the filled worksheet.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Worksheet, WorksheetEntry, WorksheetKey } from './worksheet.ts';

const PLACEHOLDER = '/*__ENTRIES__*/';

/**
 * The two contexts are two different jobs and must be two different pages.
 * They are usually open side by side — the primary pass and the blind pass —
 * and a labeller who confuses the tabs has silently destroyed the separability
 * measurement, so the name in the tab has to say which one this is.
 */
const TITLE_MARK = '>Root Cause Ledger<';
const TITLES: Record<string, string> = {
  full: 'Root Cause Ledger',
  'payload-only': 'Sealed Ledger',
};

export function templatePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'ledger', 'ledger.tpl.html');
}

/**
 * Fields the page renders. Listed rather than spread so that a field added to
 * the worksheet later cannot silently reach a payload-only page: adding it here
 * is a deliberate act, and the payload-only worksheet does not carry the
 * provenance fields in the first place.
 */
const KEEP = [
  'entryId',
  'corpusRunId',
  'failureId',
  'repo',
  'workflow',
  'commit',
  'test',
  'suite',
  'file',
  'status',
  'attempt',
  'durationMs',
  'errorType',
  'message',
  'stack',
] as const satisfies readonly (keyof WorksheetEntry)[];

/**
 * `</script>` anywhere in a failure message would end the data block early and
 * spill the rest of the corpus into the document as markup. CI logs contain
 * arbitrary bytes, so this is a real case and not a theoretical one.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/**
 * How often the payload names its own repository.
 *
 * Withholding metadata does not make a failure anonymous. Stack frames carry
 * checkout paths (`/home/runner/work/<repo>/<repo>/...`) and test names carry
 * product nouns, so a sealed worksheet can still tell the labeller exactly
 * where they are. That is not a defect to scrub — scrubbing would falsify the
 * payload, and the payload is what crux will actually show a user — but it is
 * a limit on what a separability number means, and a limit stated on the page
 * is worth more than one buried in a document nobody opens.
 *
 * Counted on owner and repository name as case-insensitive substrings of the
 * whole payload. Deliberately loose: this is an upper bound on how much the
 * labeller could recognise, and an over-count here is the safe direction.
 */
export function provenanceInPayload(
  worksheet: Worksheet,
  key: WorksheetKey,
): { matched: number; total: number } {
  let matched = 0;
  for (const e of worksheet.entries) {
    const mapped = key.entries[e.entryId];
    if (mapped === undefined) continue;
    const repo = mapped.corpusRunId.split(':')[1] ?? '';
    const terms = repo.split('/').filter((t) => t.length > 3);
    if (terms.length === 0) continue;
    const blob = [e.test, e.suite, e.file, e.message, e.stack].join('\n').toLowerCase();
    if (terms.some((t) => blob.includes(t.toLowerCase()))) matched++;
  }
  return { matched, total: worksheet.entries.length };
}

export interface LedgerOptions {
  /** Override the on-disk template. Tests use this; nothing else should. */
  template?: string;
  /**
   * The sealed worksheet's key. Only used to count how often the payload names
   * its own repository, which the page then states. Nothing from the key
   * reaches the page — the count does, the mapping does not.
   */
  key?: WorksheetKey;
}

export async function buildLedger(
  worksheet: Worksheet,
  options: LedgerOptions = {},
): Promise<string> {
  const tpl = options.template ?? (await readFile(templatePath(), 'utf8'));
  if (!tpl.includes(PLACEHOLDER)) {
    throw new Error(`ledger template has no ${PLACEHOLDER} placeholder`);
  }
  const payload = {
    schemaVersion: worksheet.schemaVersion,
    context: worksheet.context,
    selectionDigest: worksheet.selectionDigest,
    instructions: worksheet.instructions,
    provenanceInPayload:
      worksheet.context === 'payload-only' && options.key !== undefined
        ? provenanceInPayload(worksheet, options.key)
        : null,
    entries: worksheet.entries.map((e) => {
      const out: Record<string, unknown> = {};
      for (const k of KEEP) {
        if (e[k] !== undefined) out[k] = e[k];
      }
      return out;
    }),
  };
  const title = TITLES[worksheet.context];
  if (title === undefined) {
    throw new Error(`ledger has no title for context ${JSON.stringify(worksheet.context)}`);
  }
  if (!tpl.includes(TITLE_MARK)) {
    throw new Error(`ledger template has no ${TITLE_MARK} to name`);
  }
  return tpl
    .split(TITLE_MARK)
    .join(`>${title}<`)
    .replace(PLACEHOLDER, embedJson(payload));
}

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
import type { Worksheet, WorksheetEntry } from './worksheet.ts';

const PLACEHOLDER = '/*__ENTRIES__*/';

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

export async function buildLedger(worksheet: Worksheet, template?: string): Promise<string> {
  const tpl = template ?? (await readFile(templatePath(), 'utf8'));
  if (!tpl.includes(PLACEHOLDER)) {
    throw new Error(`ledger template has no ${PLACEHOLDER} placeholder`);
  }
  const payload = {
    schemaVersion: worksheet.schemaVersion,
    context: worksheet.context,
    selectionDigest: worksheet.selectionDigest,
    instructions: worksheet.instructions,
    entries: worksheet.entries.map((e) => {
      const out: Record<string, unknown> = {};
      for (const k of KEEP) {
        if (e[k] !== undefined) out[k] = e[k];
      }
      return out;
    }),
  };
  return tpl.replace(PLACEHOLDER, embedJson(payload));
}

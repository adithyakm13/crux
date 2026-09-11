/**
 * Import labels captured by a published ledger page.
 *
 * The page stores one document per entry under `labels/<labeler>/entries/`,
 * keyed by the opaque entry id rather than by failure, because a sealed page
 * has no corpus identity to key on. Resolving those ids back to
 * (corpusRunId, failureId) needs the worksheet's key file — the same sidecar
 * `corpus import` reads — so the mapping stays in one place and a page cannot
 * invent a failure that is not in the selection.
 *
 * Rejects rather than repairs, for the same reason the worksheet importer
 * does: a label attached to the wrong failure is worse than a failed import,
 * because nothing downstream would ever notice.
 */

import { SCHEMA_VERSION, CATEGORIES, type Category } from '@cruxci/core';
import type { FailureLabel, RunLabels } from './schema.ts';
import type { WorksheetKey } from './worksheet.ts';
import type { LabelContext } from './label.ts';

/** One `labels/<labeler>/entries/<entryId>` document as the page writes it. */
export interface LedgerDoc {
  id: string;
  group?: unknown;
  category?: unknown;
  note?: unknown;
}

export interface DbImportResult {
  labels: RunLabels[];
  filled: number;
  blank: number;
  unresolved: string[];
}

export function importLedgerDocs(
  docs: readonly LedgerDoc[],
  key: WorksheetKey,
  labeler: string,
  labeledAt: string,
  context: LabelContext,
): DbImportResult {
  const valid = new Set<string>(CATEGORIES);
  const byRun = new Map<string, RunLabels>();
  const unresolved: string[] = [];
  const problems: string[] = [];
  let filled = 0;
  let blank = 0;

  for (const doc of docs) {
    const group = String(doc.group ?? '').trim();
    const category = String(doc.category ?? '').trim().toUpperCase();
    if (group === '' && category === '') {
      blank++;
      continue;
    }
    const mapped = key.entries[doc.id];
    if (mapped === undefined) {
      // A document whose id is not in the key is not importable, and guessing
      // which failure it meant is exactly the error worth refusing.
      unresolved.push(doc.id);
      continue;
    }
    if (group === '') {
      problems.push(`${doc.id}: has a category but no group`);
      continue;
    }
    if (category === '') {
      problems.push(`${doc.id}: has a group but no category`);
      continue;
    }
    if (!valid.has(category)) {
      problems.push(`${doc.id}: "${String(doc.category)}" is not a category`);
      continue;
    }

    let rl = byRun.get(mapped.corpusRunId);
    if (rl === undefined) {
      rl = {
        schemaVersion: SCHEMA_VERSION,
        corpusRunId: mapped.corpusRunId,
        labeler,
        labeledAt,
        context,
        labels: {},
      };
      byRun.set(mapped.corpusRunId, rl);
    }
    const label: FailureLabel = { group, category: category as Category };
    const note = String(doc.note ?? '').trim();
    if (note !== '') label.note = note;
    rl.labels[mapped.failureId] = label;
    filled++;
  }

  if (problems.length > 0) {
    throw new Error(`${problems.length} problem(s):\n  ` + problems.slice(0, 20).join('\n  '));
  }
  return { labels: [...byRun.values()], filled, blank, unresolved };
}

/**
 * Offline labelling worksheet.
 *
 * The interactive labeller is a readline loop, which is fine for a dozen
 * failures and tiring for a hundred and fifty. It also cannot be handed to
 * someone else: recruiting a second labeller — which Gate 0 requires — means
 * asking them to install a toolchain and run a CLI.
 *
 * A worksheet is a single JSON file. Every failure carries the payload needed
 * to judge it and two blank fields to fill. It is edited in any editor, at any
 * pace, and read back with the same validation the interactive path uses.
 *
 * The contamination rules are identical and are enforced here rather than
 * trusted:
 *  - `context` is stamped into the file, and importing restores it, so a
 *    payload-only worksheet cannot be imported as a full-context one and
 *    quietly corrupt the separability rate.
 *  - a payload-only worksheet omits repository, workflow, branch and commit,
 *    because that is the condition separability is defined over.
 *  - no worksheet ever contains another labeller's answers, or crux's own
 *    prediction. Reading one cannot anchor you.
 */

import { CATEGORIES, SCHEMA_VERSION, type Category } from '@cruxci/core';
import type { CorpusRun, FailureLabel, RunLabels } from './schema.ts';
import type { LabelContext } from './label.ts';

export interface WorksheetEntry {
  /**
   * Opaque handle for this entry. Do not edit.
   *
   * In a payload-only worksheet this is ALL the identity there is, because
   * `corpusRunId` embeds the repository name — `github-actions:acme/app:1:1` —
   * so carrying it would hand the labeller the repository in every row and
   * silently void the separability condition. The mapping back to
   * (corpusRunId, failureId) lives in a sidecar key file that the labeller has
   * no reason to open and `import` reads.
   */
  entryId: string;
  /** Present only in a full-context worksheet; withheld in payload-only. */
  corpusRunId?: string;
  failureId?: string;
  repo?: string;
  workflow?: string;
  commit?: string;
  test: string;
  suite: string;
  file: string | null;
  status: string;
  attempt: number;
  durationMs: number | null;
  errorType: string | null;
  message: string;
  stack: string | null;
  stdout?: string | null;
  /** ---- fill these two in ---- */
  group: string;
  category: string;
  note: string;
}

/** Maps a worksheet's opaque entry ids back to corpus identity. */
export interface WorksheetKey {
  schemaVersion: number;
  selectionDigest: string | null;
  entries: Record<string, { corpusRunId: string; failureId: string }>;
}

export interface Worksheet {
  schemaVersion: number;
  context: LabelContext;
  /** Digest of the selection, so a filled worksheet can be matched to it. */
  selectionDigest: string | null;
  instructions: string[];
  categories: string[];
  entries: WorksheetEntry[];
}

const INSTRUCTIONS = [
  'Fill in "group" and "category" for every entry. Leave "note" blank unless',
  'something is worth saying — notes are invaluable when two labellers disagree.',
  '',
  'GROUP: which failures share ONE ROOT CAUSE. Any stable string; failures with',
  'the same string are claimed to have the same underlying cause. A failure with',
  'a cause of its own gets its own group.',
  '',
  '  Group by CAUSE, not by symptom. Two failures with completely different',
  '  error text share a group if one broken thing caused both. Three retries of',
  '  one test are one cause. Twenty tests failing because one service was down',
  '  are one cause, however differently they phrase it.',
  '',
  '  Do NOT group by: the same error class, the same test file, the same',
  '  component, or "both look like infrastructure". Those are categories of',
  '  explanation, not shared causes.',
  '',
  'CATEGORY: one of the values in "categories" below.',
  '',
  '  UNKNOWN is a real answer, not a cop-out. Use it whenever the payload does',
  '  not actually tell you. A confident wrong label is more expensive than an',
  '  honest UNKNOWN, because the whole point of this corpus is to be the thing',
  '  other numbers are checked against.',
  '',
  'Do not add, remove or reorder entries, and do not edit corpusRunId or',
  'failureId — the import matches on them and will refuse a worksheet whose',
  'entries do not correspond to the selection.',
];

/**
 * Deterministic PRNG, seeded from a string.
 *
 * Determinism matters: the same selection must always produce the same sealed
 * worksheet, or two labellers handed "the same file" are not comparing notes
 * on the same thing, and a regenerated worksheet silently stops matching the
 * one already being filled in.
 */
function mulberry32(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWorksheet(
  runs: readonly CorpusRun[],
  selection: { digest?: string; runs: { corpusRunId: string; failureIds?: string[] }[] },
  context: LabelContext,
): { worksheet: Worksheet; key: WorksheetKey } {
  const byId = new Map(runs.map((r) => [r.corpusRunId, r]));
  const entries: WorksheetEntry[] = [];
  const key: WorksheetKey['entries'] = {};
  let ordinal = 0;

  // Gather first, so a payload-only worksheet can be shuffled before ids are
  // assigned. Corpus order groups a run's failures together, and run adjacency
  // is provenance: twenty-four consecutive entries announce "one CI run" as
  // loudly as the repository name would, and that is a grouping hint the
  // separability condition is supposed to withhold. Shuffling also removes the
  // ordering itself as a cue, since a run's failures arrive in file order.
  const picked: { run: CorpusRun; failure: CorpusRun['failures'][number] }[] = [];
  for (const sel of selection.runs) {
    const run = byId.get(sel.corpusRunId);
    if (run === undefined) {
      throw new Error(
        `selection names ${sel.corpusRunId}, which is not in the corpus. ` +
          `Fix: re-run \`corpus sample\` against the current corpus.`,
      );
    }
    const only = sel.failureIds === undefined ? null : new Set(sel.failureIds);
    for (const f of run.failures) {
      if (only !== null && !only.has(f.failureId)) continue;
      picked.push({ run, failure: f });
    }
  }

  if (context === 'payload-only') {
    // Fisher-Yates, seeded from the selection so the shuffle is reproducible.
    const rand = mulberry32(`payload-only:${selection.digest ?? 'no-digest'}`);
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = picked[i]!;
      picked[i] = picked[j]!;
      picked[j] = tmp;
    }
  }

  {
    for (const { run, failure: f } of picked) {
      const entryId = `e${String(++ordinal).padStart(4, '0')}`;
      key[entryId] = { corpusRunId: run.corpusRunId, failureId: f.failureId };
      const entry: WorksheetEntry = {
        entryId,
        test: f.displayName,
        suite: f.suitePath.join(' > '),
        file: f.filePath,
        status: f.status,
        attempt: f.attemptIndex,
        durationMs: f.durationMs,
        errorType: f.errorType,
        message: f.message,
        stack: f.stackText,
        group: '',
        category: '',
        note: '',
      };
      // Full context adds provenance. Payload-only withholds it, because that
      // is precisely the condition the separability rate is defined over.
      if (context === 'full') {
        entry.corpusRunId = run.corpusRunId;
        entry.failureId = f.failureId;
        entry.repo = run.source.repo;
        if (run.source.workflowName != null) entry.workflow = run.source.workflowName;
        if (run.source.headSha != null) entry.commit = run.source.headSha;
        entry.stdout = f.stdout;
      }
      entries.push(entry);
    }
  }

  return {
    worksheet: {
      schemaVersion: SCHEMA_VERSION,
      context,
      selectionDigest: selection.digest ?? null,
      instructions: INSTRUCTIONS,
      categories: [...CATEGORIES],
      entries,
    },
    key: {
      schemaVersion: SCHEMA_VERSION,
      selectionDigest: selection.digest ?? null,
      entries: key,
    },
  };
}

export interface ImportResult {
  labels: RunLabels[];
  filled: number;
  blank: number;
  context: LabelContext;
}

/**
 * Read a filled worksheet back.
 *
 * Rejects rather than repairs. A worksheet that has drifted from the selection,
 * or that carries a category the schema does not define, is a labelling session
 * whose meaning is unclear — and this corpus exists to be the thing other
 * numbers are checked against, so a silently-coerced label is worse than an
 * error message.
 */
export function parseWorksheet(
  raw: unknown,
  labeler: string,
  labeledAt: string,
  key?: WorksheetKey,
): ImportResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('worksheet is not a JSON object');
  }
  const ws = raw as Partial<Worksheet>;
  if (ws.context !== 'full' && ws.context !== 'payload-only') {
    throw new Error(
      `worksheet has context ${JSON.stringify(ws.context)}; expected "full" or "payload-only". ` +
        `Fix: regenerate it with \`corpus worksheet\` rather than editing the header.`,
    );
  }
  if (!Array.isArray(ws.entries) || ws.entries.length === 0) {
    throw new Error('worksheet has no entries');
  }

  const valid = new Set<string>(CATEGORIES);
  const byRun = new Map<string, RunLabels>();
  let filled = 0;
  let blank = 0;
  const problems: string[] = [];

  for (const [i, e] of ws.entries.entries()) {
    const where = `entry ${i + 1} (${e.entryId ?? '?'})`;
    // A payload-only worksheet carries no corpus identity at all, so the key
    // file is the only way back. Refusing rather than guessing keeps a
    // mismatched pair from producing labels attached to the wrong failures.
    const resolved =
      typeof e.corpusRunId === 'string' && typeof e.failureId === 'string'
        ? { corpusRunId: e.corpusRunId, failureId: e.failureId }
        : typeof e.entryId === 'string'
          ? key?.entries?.[e.entryId]
          : undefined;
    if (resolved === undefined) {
      problems.push(
        `${where}: cannot resolve which failure this is. A payload-only worksheet ` +
          `needs its key file (--key), and entryId must not be edited.`,
      );
      continue;
    }
    const group = String(e.group ?? '').trim();
    const category = String(e.category ?? '').trim().toUpperCase();
    if (group === '' && category === '') {
      blank++;
      continue;
    }
    if (group === '') {
      problems.push(`${where}: has a category but no group`);
      continue;
    }
    if (category === '') {
      problems.push(`${where}: has a group but no category`);
      continue;
    }
    if (!valid.has(category)) {
      problems.push(
        `${where}: "${e.category}" is not a category. Valid: ${[...CATEGORIES].join(', ')}`,
      );
      continue;
    }

    let rl = byRun.get(resolved.corpusRunId);
    if (rl === undefined) {
      rl = {
        schemaVersion: SCHEMA_VERSION,
        corpusRunId: resolved.corpusRunId,
        labeler,
        labeledAt,
        context: ws.context,
        labels: {},
      };
      byRun.set(resolved.corpusRunId, rl);
    }
    const label: FailureLabel = { group, category: category as Category };
    const note = String(e.note ?? '').trim();
    if (note !== '') label.note = note;
    rl.labels[resolved.failureId] = label;
    filled++;
  }

  if (problems.length > 0) {
    throw new Error(
      `worksheet has ${problems.length} problem(s):\n  ` + problems.slice(0, 20).join('\n  '),
    );
  }

  return { labels: [...byRun.values()], filled, blank, context: ws.context };
}

/**
 * `corpus frames` — app-frame availability, per framework, over the committed
 * corpus.
 *
 * This exists because the number it reports was previously written into
 * docs/evidence.md by hand, from a measurement taken over a working tree that
 * included runs the repository refuses to ship (licence unidentified) and that
 * has since grown. A reader following the project's own instruction — run it
 * yourself — got 0.293 where the document said 0.122, with non-overlapping
 * intervals. That is precisely the failure the no-fabricated-numbers rule
 * exists to prevent, and the fix is not a more careful edit but a command that
 * emits the table.
 *
 * The output is stamped with the corpus fingerprint it was computed over, so a
 * stale copy in a document is detectable rather than merely wrong.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprint } from '@cruxci/engine';
import { wilson, type Interval } from '@cruxci/core';
import { corpusRunDir, type CorpusRun } from './schema.ts';
import { detectFramework } from './status.ts';

export interface FrameRow {
  framework: string;
  failures: number;
  withAnyFrame: number;
  withAppFrame: number;
  rate: Interval;
  /** How many repositories contribute failures to this row. */
  repositories: number;
  /**
   * Share of the row supplied by its largest repository.
   *
   * A framework row that is one repository's data is a claim about that
   * repository. jest read 0/1029 until a second project appeared and returned
   * 12/30 — non-overlapping intervals for the same framework, because the first
   * project's harness wraps every frame. Without this column that row looked
   * like a fact about jest.
   */
  topRepoShare: number;
}

export interface FrameReport {
  rows: FrameRow[];
  total: FrameRow;
  runs: number;
  repositories: number;
  /** Stable digest of the exact run set measured, so staleness is detectable. */
  corpusDigest: string;
}

/**
 * Adapters whose name identifies a framework rather than a file format. Kept in
 * step with status.ts: only the Playwright blob report is framework-specific.
 */
const FRAMEWORK_IDENTIFYING_ADAPTERS = new Set(['playwright']);

/**
 * Restrict a run set to the runs actually committed to version control.
 *
 * A published figure has to be one a reader can reproduce from a clone. The
 * working tree may hold runs the repository deliberately does not ship —
 * repositories whose licence GitHub cannot identify — and measuring over those
 * produces a number that exists nowhere but this machine.
 */
export async function committedRuns(repoDir: string, runs: CorpusRun[]): Promise<CorpusRun[]> {
  const { stdout } = await promisify(execFile)('git', ['ls-files', 'corpus/runs'], {
    cwd: repoDir,
    maxBuffer: 32 * 1024 * 1024,
  });
  const dirs = new Set(
    stdout
      .split('\n')
      .filter((l) => l.endsWith('/run.json'))
      .map((l) => l.split('/')[2])
      .filter((d): d is string => d !== undefined),
  );
  // corpusRunId is `provider:owner/repo:runId:attempt`; the harvester sanitizes
  // it into a directory name, so compare on that.
  return runs.filter((r) => dirs.has(corpusRunDir(r.corpusRunId)));
}

export function frameReport(runs: CorpusRun[]): FrameReport {
  const buckets = new Map<
    string,
    { failures: number; withAnyFrame: number; withAppFrame: number; byRepo: Map<string, number> }
  >();
  for (const run of runs) {
    for (const f of run.failures) {
      const inferred = detectFramework(f.sourceFile, f.stackText, f.errorType);
      const key =
        inferred !== 'unknown'
          ? inferred
          : f.producerAdapter !== undefined &&
              FRAMEWORK_IDENTIFYING_ADAPTERS.has(f.producerAdapter)
            ? f.producerAdapter
            : 'unidentified';
      let b = buckets.get(key);
      if (b === undefined) {
        b = { failures: 0, withAnyFrame: 0, withAppFrame: 0, byRepo: new Map<string, number>() };
        buckets.set(key, b);
      }
      b.byRepo.set(run.source.repo, (b.byRepo.get(run.source.repo) ?? 0) + 1);
      const fp = fingerprint({
        errorType: f.errorType,
        message: f.message,
        stackText: f.stackText,
      });
      b.failures++;
      if (fp.frames.length > 0) b.withAnyFrame++;
      if (fp.deepestAppFrame !== null) b.withAppFrame++;
    }
  }

  const rows: FrameRow[] = [...buckets]
    .map(([framework, b]) => ({
      framework,
      failures: b.failures,
      withAnyFrame: b.withAnyFrame,
      withAppFrame: b.withAppFrame,
      rate: wilson(b.withAppFrame, b.failures),
      repositories: b.byRepo.size,
      topRepoShare:
        b.failures === 0 ? 0 : Math.max(...b.byRepo.values()) / b.failures,
    }))
    .sort((a, b) => b.failures - a.failures || a.framework.localeCompare(b.framework));

  const sum = rows.reduce(
    (a, r) => ({
      failures: a.failures + r.failures,
      withAnyFrame: a.withAnyFrame + r.withAnyFrame,
      withAppFrame: a.withAppFrame + r.withAppFrame,
    }),
    { failures: 0, withAnyFrame: 0, withAppFrame: 0 },
  );
  const allRepos = new Set(runs.map((r) => r.source.repo));

  return {
    rows,
    total: {
      framework: 'total',
      ...sum,
      rate: wilson(sum.withAppFrame, sum.failures),
      repositories: allRepos.size,
      topRepoShare: 0,
    },
    runs: runs.length,
    repositories: new Set(runs.map((r) => r.source.repo)).size,
    corpusDigest: digestOf(runs),
  };
}

/** Digest of the run ids measured, order-independent. */
function digestOf(runs: CorpusRun[]): string {
  const h = createHash('sha256');
  for (const id of runs.map((r) => r.corpusRunId).sort()) h.update(id + '\n');
  return h.digest('hex').slice(0, 12);
}

const iv = (i: Interval) =>
  Number.isFinite(i.point)
    ? `${i.point.toFixed(3)} [${i.lower.toFixed(3)}, ${i.upper.toFixed(3)}]`
    : 'n/a';

export function formatFrameReport(r: FrameReport): string {
  const w = Math.max(12, ...r.rows.map((x) => x.framework.length));
  const lines: string[] = [];
  lines.push(
    `app-frame availability over ${r.runs} run(s), ${r.repositories} repositor` +
      `${r.repositories === 1 ? 'y' : 'ies'} (corpus ${r.corpusDigest})`,
  );
  lines.push('');
  lines.push(
    `  ${'framework'.padEnd(w)}  ${'failures'.padStart(8)}  ${'w/ frame'.padStart(8)}  ` +
      `${'w/ app'.padStart(6)}  ${'repos'.padStart(5)}  rate (Wilson 95%)`,
  );
  let flagged = false;
  for (const row of [...r.rows, r.total]) {
    const single = row.framework !== 'total' && row.repositories === 1;
    const dominated = row.framework !== 'total' && row.repositories > 1 && row.topRepoShare > 0.8;
    if (single || dominated) flagged = true;
    lines.push(
      `  ${row.framework.padEnd(w)}  ${String(row.failures).padStart(8)}  ` +
        `${String(row.withAnyFrame).padStart(8)}  ${String(row.withAppFrame).padStart(6)}  ` +
        `${String(row.repositories).padStart(5)}  ${iv(row.rate)}` +
        (single ? '  <- one repository' : dominated ? `  <- ${(row.topRepoShare * 100).toFixed(0)}% one repository` : ''),
    );
  }
  if (flagged) {
    lines.push('');
    lines.push(
      '  A flagged row is a claim about those repositories, not about the framework.',
    );
    lines.push(
      '  jest read 0/1029 until a second project appeared and returned 12/30 —',
    );
    lines.push(
      '  non-overlapping intervals for the same framework, because the first',
    );
    lines.push('  project wraps every frame in its own harness.');
  }
  return lines.join('\n');
}

/** Markdown, so docs can be regenerated rather than edited by hand. */
export function frameReportMarkdown(r: FrameReport): string {
  const lines: string[] = [];
  lines.push(`| Framework | Failures | With an app frame | Repos | Rate (Wilson 95%) |`);
  lines.push(`|---|---|---|---|---|`);
  for (const row of r.rows) {
    const note =
      row.repositories === 1
        ? ' **1**'
        : row.topRepoShare > 0.8
          ? ` ${row.repositories}*`
          : ` ${row.repositories}`;
    lines.push(
      `| ${row.framework} | ${row.failures} | ${row.withAppFrame} |${note} | ${iv(row.rate)} |`,
    );
  }
  lines.push(
    `| **total** | **${r.total.failures}** | **${r.total.withAppFrame}** | **${r.total.repositories}** | **${iv(r.total.rate)}** |`,
  );
  lines.push('');
  lines.push(
    'A **bold** repository count means the row is one repository, and `*` means one ' +
      'repository supplies over 80% of it. Such a row is a claim about those ' +
      'repositories, not about the framework.',
  );
  lines.push('');
  lines.push(
    `Measured over ${r.runs} committed run(s) across ${r.repositories} repositories ` +
      `(corpus \`${r.corpusDigest}\`). Regenerate with \`pnpm corpus frames --markdown\`.`,
  );
  return lines.join('\n');
}

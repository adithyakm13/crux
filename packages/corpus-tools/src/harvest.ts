/**
 * Corpus harvester (§2, sourcing step 2: public GitHub Actions runs that upload
 * test artifacts).
 *
 * What it does: for each repository, walk recent failed workflow runs, download
 * every non-expired artifact that plausibly holds test results, find the JUnit
 * XML inside, parse it with the real adapter, and write one `CorpusRun` per
 * workflow run that actually contains failures.
 *
 * What it deliberately does not do:
 *  - It does not label anything. Labels come from humans, in separate files.
 *  - It does not keep runs with zero failures. They carry no clustering signal,
 *    and counting them would inflate the run count the gate is stated in.
 *  - It does not keep the raw zips in the committed tree. Only the extracted
 *    failure payloads and their provenance are written under `corpus/runs`.
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

/**
 * How much total inflated output one artifact may produce, as a multiple of the
 * compressed cap. A real test-results zip compresses maybe 10:1; 40x leaves
 * generous headroom while making a 40 MiB artifact unable to inflate into
 * gigabytes.
 */
const ZIP_INFLATE_BUDGET_FACTOR = 40;
import { JUnitAdapter } from '@cruxci/adapter-junit';
import { PlaywrightAdapter } from '@cruxci/adapter-playwright';
import type { ParseWarning, RawAttempt, TestResultAdapter } from '@cruxci/core';
import {
  corpusRunDir,
  newCorpusRun,
  validateCorpusRun,
  type CorpusFailure,
  type CorpusRun,
  type RunSource,
} from './schema.ts';
import {
  downloadArtifact,
  listArtifacts,
  listFailedRuns,
  repoMeta,
  type ArtifactRef,
} from './github.ts';

export interface HarvestOptions {
  corpusDir: string;
  /** Failed runs to examine per repository. */
  runsPerRepo: number;
  /** Skip artifacts larger than this; Playwright HTML reports are mostly video. */
  maxArtifactBytes: number;
  /** Skip a single XML file larger than this. */
  maxXmlBytes: number;
  /**
   * Total artifact bytes downloaded per workflow run. A sharded Playwright
   * suite uploads a blob report per shard, so an unbounded harvest spends most
   * of its time re-downloading the same suite across consecutive runs of the
   * same repository. Once the budget is spent the run is kept with whatever was
   * parsed, and the shortfall is recorded rather than hidden.
   */
  maxBytesPerRun: number;
  /** Refuse to harvest repositories without an identifiable licence. */
  requireLicense: boolean;
  onProgress?: (line: string) => void;
}

export const DEFAULT_HARVEST_OPTIONS: Omit<HarvestOptions, 'corpusDir'> = {
  runsPerRepo: 30,
  maxArtifactBytes: 40 * 1024 * 1024,
  maxXmlBytes: 32 * 1024 * 1024,
  maxBytesPerRun: 80 * 1024 * 1024,
  requireLicense: true,
};

/**
 * Artifact names worth downloading. Deliberately generous — the cost of a
 * miss is a lost run, the cost of a false positive is one wasted download that
 * yields no XML and is discarded.
 */
const ARTIFACT_NAME_HINT =
  /junit|test.?results?|test.?report|surefire|failsafe|pytest|xunit|nunit|trx|blob-report|playwright/i;

export interface HarvestSummary {
  repo: string;
  runsExamined: number;
  runsWithArtifacts: number;
  runsKept: number;
  failuresKept: number;
  skipped: { reason: string; count: number }[];
}

export async function harvestRepo(repo: string, opts: HarvestOptions): Promise<HarvestSummary> {
  const log = opts.onProgress ?? (() => {});
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const meta = await repoMeta(repo);
  if (opts.requireLicense && meta.licenseSpdx === null) {
    // Failure text is derived from the repository's own source and test code, so
    // by default crux does not pull it out of a repository whose licence it
    // cannot name. The two reasons are reported separately because they call for
    // different responses: NOASSERTION usually means a mixed or custom LICENSE
    // that a human can read and clear, while a missing licence means there is
    // nothing to read.
    const reason =
      meta.licenseRaw === 'NOASSERTION'
        ? 'licence present but unidentified (NOASSERTION) — review it, then pass --allow-unlicensed'
        : 'repository has no licence file';
    return {
      repo,
      runsExamined: 0,
      runsWithArtifacts: 0,
      runsKept: 0,
      failuresKept: 0,
      skipped: [{ reason, count: 1 }],
    };
  }

  const runs = await listFailedRuns(repo, opts.runsPerRepo);
  let runsWithArtifacts = 0;
  let runsKept = 0;
  let failuresKept = 0;

  for (const wr of runs) {
    const source: RunSource = {
      provider: 'github-actions',
      repo,
      providerRunId: wr.id,
      runAttempt: wr.runAttempt,
      url: wr.url,
      workflowName: wr.workflowName,
      event: wr.event,
      headSha: wr.headSha,
      headBranch: wr.headBranch,
      artifactIds: [],
      licenseSpdx: meta.licenseSpdx,
      licenseRaw: meta.licenseRaw,
      retrievedAt: new Date().toISOString(),
    };
    const corpusRun = newCorpusRun({ source, fidelity: 'artifact' });

    if (await runExists(opts.corpusDir, corpusRun.corpusRunId)) {
      skip('already harvested');
      continue;
    }

    let artifacts: ArtifactRef[];
    try {
      artifacts = await listArtifacts(repo, wr.id);
    } catch (e) {
      skip(`artifact listing failed: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }

    log(`  run ${wr.id}: ${artifacts.filter((a) => !a.expired).length} live artifact(s)`);
    const wanted = artifacts.filter(
      (a) => !a.expired && a.sizeInBytes <= opts.maxArtifactBytes && ARTIFACT_NAME_HINT.test(a.name),
    );
    if (artifacts.some((a) => !a.expired)) runsWithArtifacts++;
    if (wanted.length === 0) {
      skip(artifacts.every((a) => a.expired) ? 'all artifacts expired' : 'no test-like artifact');
      continue;
    }

    const warnCounts = new Map<string, number>();
    // Shard index is the artifact's position in this run. The provider does not
    // report a shard number per artifact, and inventing a shard identity that
    // claims more than "these came from different uploads" would be fabrication.
    let shardIndex = -1;
    let bytesThisRun = 0;
    let artifactsSkippedForBudget = 0;
    // Smallest first: a JUnit XML is kilobytes and a Playwright HTML report is
    // megabytes of video, so this spends the budget on the highest-yield files.
    const ordered = [...wanted].sort((a, b) => a.sizeInBytes - b.sizeInBytes);
    for (const art of ordered) {
      shardIndex++;
      if (bytesThisRun + art.sizeInBytes > opts.maxBytesPerRun) {
        artifactsSkippedForBudget++;
        continue;
      }
      let zip: Buffer;
      try {
        zip = await downloadArtifact(repo, art.id);
      } catch (e) {
        skip(`download failed: ${(e as Error).message.slice(0, 60)}`);
        continue;
      }
      bytesThisRun += zip.byteLength;
      let entries: Record<string, Uint8Array>;
      try {
        // Filter BEFORE inflating. `maxArtifactBytes` caps only the compressed
        // size GitHub reports, and the per-entry check further down runs on
        // already-decompressed bytes — a cap checked after the damage. fflate's
        // filter sees `originalSize` from the central directory, so an entry
        // that would inflate past the cap is never expanded at all. A budget
        // across entries bounds the many-small-entries variant, which no
        // per-entry cap catches.
        let inflatedBudget = opts.maxArtifactBytes * ZIP_INFLATE_BUDGET_FACTOR;
        entries = unzipSync(new Uint8Array(zip), {
          filter: (f) => {
            if (f.originalSize > opts.maxXmlBytes) return false;
            if (f.originalSize > inflatedBudget) return false;
            inflatedBudget -= f.originalSize;
            return true;
          },
        });
      } catch (e) {
        skip(`unzip failed: ${(e as Error).message.slice(0, 60)}`);
        continue;
      }
      // Playwright's blob-report artifact is a zip of per-shard zips, so one
      // level of nesting is unwrapped. Deeper nesting is not followed: a zip
      // bomb is exactly a deeply nested archive, and no real reporter produces
      // one.
      const flat: Record<string, Uint8Array> = {};
      for (const [name, bytes] of Object.entries(entries)) {
        if (name.toLowerCase().endsWith('.zip') && bytes.byteLength <= opts.maxArtifactBytes) {
          try {
            let innerBudget = opts.maxArtifactBytes * ZIP_INFLATE_BUDGET_FACTOR;
            const inflated = unzipSync(bytes, {
              filter: (f) => {
                if (f.originalSize > opts.maxXmlBytes) return false;
                if (f.originalSize > innerBudget) return false;
                innerBudget -= f.originalSize;
                return true;
              },
            });
            for (const [inner, innerBytes] of Object.entries(inflated)) {
              flat[`${name}!${inner}`] = innerBytes;
            }
            continue;
          } catch {
            skip('nested unzip failed');
            continue;
          }
        }
        flat[name] = bytes;
      }

      let usedThisArtifact = false;
      for (const [entryName, bytes] of Object.entries(flat)) {
        if (bytes.byteLength === 0 || bytes.byteLength > opts.maxXmlBytes) continue;
        const adapter = pickAdapter(entryName, bytes);
        if (adapter === null) continue;
        const parsed = await parseWith(adapter, bytes, warnCounts, shardIndex);
        if (parsed === null) {
          corpusRun.counts.filesRejected++;
          continue;
        }
        corpusRun.counts.filesParsed++;
        usedThisArtifact = true;
        absorb(corpusRun, parsed, entryName, art.name, adapter.name);
      }
      if (usedThisArtifact) source.artifactIds.push(art.id);
    }

    corpusRun.warnings = [...warnCounts].map(([code, count]) => ({ code, count }));
    if (artifactsSkippedForBudget > 0) {
      corpusRun.warnings.push({
        code: 'ARTIFACTS_OVER_BUDGET',
        count: artifactsSkippedForBudget,
      });
    }

    if (corpusRun.counts.failures === 0) {
      // A run with no parsed failures carries no clustering signal. Counting it
      // would inflate the run count the Gate 0 threshold is stated in.
      skip(corpusRun.counts.filesParsed === 0 ? 'no parseable test results in artifacts' : 'no failures in run');
      continue;
    }

    await writeRun(opts.corpusDir, corpusRun);
    runsKept++;
    failuresKept += corpusRun.counts.failures;
    log(
      `  kept ${corpusRun.corpusRunId} — ${corpusRun.counts.failures} failures ` +
        `from ${corpusRun.counts.filesParsed} file(s)`,
    );
  }

  return {
    repo,
    runsExamined: runs.length,
    runsWithArtifacts,
    runsKept,
    failuresKept,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Choose an adapter from the bytes, not from the filename alone. Artifacts are
 * full of files whose extension promises more than their contents deliver.
 * Returning null means "this file is not test results", which is the common
 * case inside a report archive.
 */
function pickAdapter(entryName: string, bytes: Uint8Array): TestResultAdapter | null {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  const lower = entryName.toLowerCase();
  if (lower.endsWith('.xml') && /<\s*testsuites?[\s>]/i.test(head)) return new JUnitAdapter();
  if (lower.endsWith('.jsonl') && head.includes('"method"')) return new PlaywrightAdapter();
  if (lower.endsWith('.json') && /"suites"\s*:/.test(head) && /"config"\s*:|"specs"\s*:/.test(head)) {
    return new PlaywrightAdapter();
  }
  return null;
}

async function parseWith(
  adapter: TestResultAdapter,
  bytes: Uint8Array,
  warnCounts: Map<string, number>,
  shardIndex: number,
): Promise<RawAttempt[] | null> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const out: RawAttempt[] = [];
  const onWarning = (w: ParseWarning) => warnCounts.set(w.code, (warnCounts.get(w.code) ?? 0) + 1);
  try {
    for await (const a of adapter.parse(stream, { skipInvalid: true, onWarning, shardIndex })) {
      out.push(a);
    }
  } catch (e) {
    const code = `parse_failed:${adapter.name}:${(e as { code?: string }).code ?? 'unknown'}`;
    warnCounts.set(code, (warnCounts.get(code) ?? 0) + 1);
    return null;
  }
  return out;
}

function absorb(
  run: CorpusRun,
  attempts: RawAttempt[],
  entryName: string,
  artifactName: string,
  producerAdapter: string,
): void {
  for (const a of attempts) {
    run.counts.attempts++;
    if (a.status === 'passed') run.counts.passed++;
    else if (a.status === 'skipped') run.counts.skipped++;
    if (a.failure === null) continue;
    run.counts.failures++;
    const failureId = `f${String(run.failures.length + 1).padStart(4, '0')}`;
    const f: CorpusFailure = {
      failureId,
      sourceFile: `${artifactName}/${entryName}`,
      producerAdapter,
      shardIndex: a.shardIndex,
      attemptIndex: a.attemptIndex,
      displayName: a.displayName,
      suitePath: a.suitePath,
      filePath: a.filePath,
      status: a.status,
      durationMs: a.durationMs,
      errorType: a.failure.errorType,
      message: a.failure.message,
      stackText: a.failure.stackText,
      stdout: a.failure.stdout,
      stderr: a.failure.stderr,
    };
    run.failures.push(f);
  }
}

// ---------------------------------------------------------------------------
// Disk layout
// ---------------------------------------------------------------------------

export function runsDir(corpusDir: string): string {
  return join(corpusDir, 'runs');
}

export async function writeRun(corpusDir: string, run: CorpusRun): Promise<string> {
  const dir = join(runsDir(corpusDir), corpusRunDir(run.corpusRunId));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'run.json');
  await writeFile(path, JSON.stringify(run, null, 2) + '\n', 'utf8');
  return path;
}

export async function runExists(corpusDir: string, corpusRunId: string): Promise<boolean> {
  try {
    await readFile(join(runsDir(corpusDir), corpusRunDir(corpusRunId), 'run.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function loadRuns(corpusDir: string): Promise<CorpusRun[]> {
  let dirs: string[];
  try {
    dirs = await readdir(runsDir(corpusDir));
  } catch {
    return [];
  }
  const out: CorpusRun[] = [];
  for (const d of dirs.sort()) {
    const path = join(runsDir(corpusDir), d, 'run.json');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    out.push(validateCorpusRun(JSON.parse(text), path));
  }
  return out;
}

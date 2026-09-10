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
import { gunzipSync, unzipSync } from 'fflate';
import { DEFAULT_UNTAR_LIMITS, isGzipped, isTarball, untar } from './untar.ts';

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
 * Artifact names worth downloading. Deliberately generous — the cost of a miss
 * is a lost run, the cost of a false positive is one wasted download whose
 * contents dispatch to no adapter and are discarded.
 *
 * `build-reports` is here because quarkus names its surefire and failsafe
 * bundles `build-reports-1-<job>`, and requiring the word "test" before
 * "report" skipped every one of them — a repository verified to carry 1126
 * JUnit XML files harvested to nothing. The name only decides what to
 * DOWNLOAD; pickAdapter still decides what counts, so widening this trades
 * bandwidth for coverage and cannot admit a non-test artifact into the corpus.
 */
export const ARTIFACT_NAME_HINT =
  /junit|test.?results?|(?:test|build)[-_. ]?reports?|surefire|failsafe|pytest|xunit|nunit|trx|blob-report|playwright/i;

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
      skip(
        artifacts.length === 0
          ? 'uploads no artifacts at all'
          : artifacts.every((a) => a.expired)
            ? 'all artifacts expired'
            : 'no test-like artifact',
      );
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
        // Maven and Gradle CI often tar their reports before uploading, so the
        // artifact holds one test-reports.tgz rather than the XML. Unwrapping
        // only .zip meant those artifacts dispatched to no adapter and were
        // discarded whole — quarkusio/quarkus carries 1126 JUnit XML files and
        // 248 failures in exactly that shape and yielded nothing.
        if (isTarball(name) && bytes.byteLength <= opts.maxArtifactBytes) {
          try {
            const raw = isGzipped(name, bytes) ? gunzipSync(bytes) : bytes;
            const members = untar(raw, {
              ...DEFAULT_UNTAR_LIMITS,
              maxEntryBytes: opts.maxXmlBytes,
              maxTotalBytes: opts.maxArtifactBytes * ZIP_INFLATE_BUDGET_FACTOR,
            });
            for (const [inner, innerBytes] of Object.entries(members)) {
              flat[`${name}!${inner}`] = innerBytes;
            }
            continue;
          } catch {
            skip('nested untar failed');
            continue;
          }
        }
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
/**
 * Content-based dispatch. Exported so `corpus scan` can ask the same question
 * the harvester will ask, rather than approximating it.
 *
 * A scan that only matched artifact *names* declared 27 repositories productive
 * and the harvest then kept runs from one: `playwright-report/` containing only
 * HTML passes any name filter and parses to nothing. Scan and harvest must run
 * the same predicate or the scan is measuring something else.
 */
export function pickAdapter(entryName: string, bytes: Uint8Array): TestResultAdapter | null {
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


export interface ProbeResult {
  repo: string;
  /** True when at least one artifact parsed to at least one failure. */
  productive: boolean;
  runsExamined: number;
  artifactsDownloaded: number;
  bytesDownloaded: number;
  failuresFound: number;
  /** Adapters that successfully parsed something, for reporting. */
  adapters: string[];
  /** Why it was not productive, when it was not. */
  reason: string | null;
}

export interface ProbeOptions {
  /**
   * Failed runs to examine before giving up.
   *
   * Defaults to the same depth `harvest` uses. A shallower probe answers a
   * different question than the harvest will: druxt/druxt.js is productive at
   * depth 25 and looks dead at depth 10, because its four productive runs are
   * older than its ten most recent failures. A scan that disagrees with the
   * harvest is the bug this whole command exists to fix.
   */
  runsToProbe?: number;
  /**
   * Artifacts to download per run, not per repository.
   *
   * A repository-wide cap is exhausted by the newest runs, and the newest run
   * is frequently the one that failed for an uninteresting reason. druxt/druxt.js
   * kept four runs during a real harvest and a global cap of twelve downloads
   * still reported it unproductive, because the productive runs were older than
   * the budget reached.
   */
  maxDownloadsPerRun?: number;
  /** Total bytes to spend on one repository before giving up. */
  maxBytes?: number;
  maxArtifactBytes?: number;
  requireLicense?: boolean;
  onProgress?: (line: string) => void;
}

/**
 * Ask whether a repository would actually yield corpus data, by doing what the
 * harvester does and stopping at the first parseable failure.
 *
 * Downloads real artifacts, so it is not free — but it is bounded to a couple
 * of the smallest candidates per repository, and it is far cheaper than a full
 * harvest that turns out to yield nothing.
 */
export async function probeRepo(repo: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const runsToProbe = options.runsToProbe ?? 25;
  const maxDownloadsPerRun = options.maxDownloadsPerRun ?? 4;
  const maxBytes = options.maxBytes ?? 60 * 1024 * 1024;
  const maxArtifactBytes = options.maxArtifactBytes ?? 40 * 1024 * 1024;
  const log = options.onProgress ?? (() => {});
  const result: ProbeResult = {
    repo,
    productive: false,
    runsExamined: 0,
    artifactsDownloaded: 0,
    bytesDownloaded: 0,
    failuresFound: 0,
    adapters: [],
    reason: null,
  };

  let meta;
  try {
    meta = await repoMeta(repo);
  } catch (e) {
    result.reason = `metadata failed: ${(e as Error).message.slice(0, 60)}`;
    return result;
  }
  if (meta.archived) {
    result.reason = 'archived';
    return result;
  }
  if ((options.requireLicense ?? true) && meta.licenseSpdx === null) {
    result.reason = `licence unidentified (${meta.licenseRaw ?? 'none'})`;
    return result;
  }

  let runs;
  try {
    runs = await listFailedRuns(repo, runsToProbe);
  } catch (e) {
    result.reason = `run listing failed: ${(e as Error).message.slice(0, 60)}`;
    return result;
  }
  if (runs.length === 0) {
    result.reason = 'no failed runs';
    return result;
  }

  let sawAnyArtifact = false;
  let sawLiveArtifact = false;
  let sawCandidate = false;
  for (const wr of runs) {
    if (result.bytesDownloaded >= maxBytes) break;
    result.runsExamined++;
    let downloadsThisRun = 0;
    let artifacts;
    try {
      artifacts = await listArtifacts(repo, wr.id);
    } catch {
      continue;
    }
    if (artifacts.length > 0) sawAnyArtifact = true;
    const live = artifacts.filter((a) => !a.expired);
    if (live.length > 0) sawLiveArtifact = true;
    // The same name filter the harvester uses, then the same content dispatch.
    const wanted = live
      .filter((a) => a.sizeInBytes <= maxArtifactBytes && ARTIFACT_NAME_HINT.test(a.name))
      .sort((a, b) => a.sizeInBytes - b.sizeInBytes);
    if (wanted.length > 0) sawCandidate = true;

    for (const art of wanted) {
      if (downloadsThisRun >= maxDownloadsPerRun) break;
      if (result.bytesDownloaded >= maxBytes) break;
      let zip: Buffer;
      try {
        zip = await downloadArtifact(repo, art.id);
      } catch {
        continue;
      }
      downloadsThisRun++;
      result.artifactsDownloaded++;
      result.bytesDownloaded += zip.byteLength;
      let entries: Record<string, Uint8Array>;
      try {
        let budget = maxArtifactBytes * ZIP_INFLATE_BUDGET_FACTOR;
        entries = unzipSync(new Uint8Array(zip), {
          filter: (f) => {
            if (f.originalSize > budget) return false;
            budget -= f.originalSize;
            return true;
          },
        });
      } catch {
        continue;
      }
      for (const [name, bytes] of Object.entries(entries)) {
        if (bytes.byteLength === 0) continue;
        const adapter = pickAdapter(name, bytes);
        if (adapter === null) continue;
        const attempts = await parseWith(adapter, bytes, new Map(), 0);
        if (attempts === null) continue;
        const failures = attempts.filter((a) => a.failure !== null).length;
        if (failures > 0) {
          result.failuresFound += failures;
          if (!result.adapters.includes(adapter.name)) result.adapters.push(adapter.name);
        }
      }
      if (result.failuresFound > 0) {
        result.productive = true;
        log(`  ${repo}: ${result.failuresFound} failure(s) via ${result.adapters.join(', ')}`);
        return result;
      }
    }
  }

  result.reason = probeReason({ sawAnyArtifact, sawLiveArtifact, sawCandidate });
  return result;
}

/**
 * Why a repository yielded nothing.
 *
 * These four are different facts with different consequences, so they get
 * different strings. A repository that uploads no artifacts at all can be
 * dropped permanently; one whose artifacts have merely expired is viable on
 * fresher runs and should be revisited, not deleted from the candidate list.
 * Conflating them sends the next scan back to repositories that can never
 * work — `[].every(...)` is `true`, which is exactly how the two got merged.
 */
export function probeReason(seen: {
  sawAnyArtifact: boolean;
  sawLiveArtifact: boolean;
  sawCandidate: boolean;
}): string {
  if (!seen.sawAnyArtifact) return 'uploads no artifacts at all';
  if (!seen.sawLiveArtifact) return 'all artifacts expired';
  if (!seen.sawCandidate) return 'no test-like artifact';
  return 'artifacts downloaded but nothing parsed to a failure';
}

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

#!/usr/bin/env node
/**
 * `corpus` — Gate 0 tooling. Not the product CLI; this is how the evidence gets
 * collected and how the gate numbers get computed.
 *
 *   corpus harvest --repos <file|list>   pull real failed CI runs into corpus/
 *   corpus status                        what the corpus contains vs Gate 0
 *   corpus frames                        app-frame availability per framework
 *   corpus sample                        choose which runs to label
 *   corpus worksheet                     offline labelling file
 *   corpus import                        read a filled worksheet back
 *   corpus scan                          which repos would actually yield data
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_HARVEST_OPTIONS, harvestRepo, loadRuns } from './harvest.ts';
import { rateLimitRemaining } from './github.ts';
import { gateZeroStatus, formatGateZeroStatus } from './status.ts';
import {
  agreementReport,
  formatAgreement,
  formatSeparability,
  labelCommand,
  listLabelers,
  loadLabelerIndex,
  separabilityReport,
} from './commands.ts';
import { formatBaselineReport, runBaseline } from './baseline.ts';
import { formatSample, sampleForLabelling } from './sample.ts';
import { probeRepo, type ProbeResult } from './harvest.ts';
import { buildWorksheet, parseWorksheet } from './worksheet.ts';
import { SCHEMA_VERSION } from '@cruxci/core';
import {
  committedRuns,
  formatFrameReport,
  frameReport,
  frameReportMarkdown,
} from './frames.ts';

function usage(): string {
  return [
    'corpus — crux ci Gate 0 tooling',
    '',
    'Usage:',
    '  corpus harvest --repos <path|owner/name,...> [--runs-per-repo N]',
    '                 [--max-bytes-per-run BYTES]',
    '  corpus status',
    '  corpus frames [--markdown] [--include-untracked]',
    '  corpus scan --repos <file> [--out <file>] [--runs N] [--downloads N]',
    '                --downloads is per run, not per repository',
    '  corpus sample [--target N] [--min-failures N] [--max-failures N]',
    '                [--slice N] [--ids | --selection <file>]',
    '  corpus worksheet --selection <file> --out <file> [--context full|payload-only]',
    '  corpus import --file <file> --labeler <name> [--key <file>]',
    '  corpus label --labeler <name> [--context full|payload-only]',
    '                [--min-failures N] [--max-failures N] [--selection <file>]',
    '  corpus agreement --a <labeler> --b <labeler>',
    '  corpus separability --full <labeler> --payload <labeler>',
    '  corpus baseline --labeler <name>',
    '',
    'Options:',
    '  --corpus DIR        corpus directory (default: ./corpus)',
    '  --runs-per-repo N   failed runs to examine per repository (default: 30)',
    '  --max-bytes-per-run BYTES  artifact bytes per run (default: 80MB). Raise for',
    '                      repositories that shard into many large artifacts.',
    '  --allow-unlicensed  harvest repositories whose licence cannot be identified',
    '  --context C         label context: full (default) or payload-only',
    '  --min-failures N    only label runs with at least N failures (default: 1)',
    '  --max-failures N    skip runs bigger than N failures (suite collapses)',
    '  --max-runs N        stop after this many runs in one sitting',
    '  --json              machine-readable output',
  ].join('\n');
}

interface Args {
  command: string | undefined;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (command === undefined) {
      command = a;
    }
  }
  return { command, flags };
}

async function resolveRepoList(spec: string): Promise<string[]> {
  // A path wins over a comma list: a file named like a repo is far less likely
  // than a repo list that happens to contain a slash.
  try {
    const text = await readFile(spec, 'utf8');
    return text
      .split('\n')
      .map((l) => l.split('#')[0]!.trim())
      .filter((l) => l !== '');
  } catch {
    return spec
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const corpusDir = resolve(String(flags.get('corpus') ?? 'corpus'));
  const json = flags.get('json') === true;

  if (command === undefined || command === 'help' || flags.get('help') === true) {
    process.stdout.write(usage() + '\n');
    return 0;
  }

  if (command === 'harvest') {
    const spec = flags.get('repos');
    if (typeof spec !== 'string') {
      process.stderr.write(
        'Error: harvest needs --repos, either a file of `owner/name` lines or a comma-separated list.\n',
      );
      return 3;
    }
    const repos = await resolveRepoList(spec);
    if (repos.length === 0) {
      process.stderr.write(`Error: no repositories found in ${spec}.\n`);
      return 3;
    }
    const runsPerRepo = Number(flags.get('runs-per-repo') ?? DEFAULT_HARVEST_OPTIONS.runsPerRepo);
    // Exposed because the per-run byte budget, not the run count, is what binds
    // on repositories that shard heavily. quarkus uploads ~95 artifacts of
    // ~11 MB per run, so the default 80 MB reaches about seven shards — and
    // since ordering is smallest-first, it reaches the SAME seven on every run,
    // which are mostly green. Raising it is the only way to see the shards that
    // actually failed.
    const maxBytesPerRun = Number(
      flags.get('max-bytes-per-run') ?? DEFAULT_HARVEST_OPTIONS.maxBytesPerRun,
    );
    const remaining = await rateLimitRemaining();
    process.stderr.write(`GitHub API budget remaining: ${remaining}\n`);

    let keptRuns = 0;
    let keptFailures = 0;
    for (const repo of repos) {
      process.stderr.write(`${repo}\n`);
      try {
        const s = await harvestRepo(repo, {
          ...DEFAULT_HARVEST_OPTIONS,
          corpusDir,
          runsPerRepo,
          maxBytesPerRun,
          requireLicense: flags.get('allow-unlicensed') !== true,
          onProgress: (line) => process.stderr.write(line + '\n'),
        });
        keptRuns += s.runsKept;
        keptFailures += s.failuresKept;
        const skips = s.skipped.map((x) => `${x.reason} x${x.count}`).join('; ');
        process.stderr.write(
          `  examined ${s.runsExamined}, kept ${s.runsKept} run(s), ` +
            `${s.failuresKept} failure(s)${skips ? ` — skipped: ${skips}` : ''}\n`,
        );
      } catch (e) {
        process.stderr.write(`  ERROR ${(e as Error).message}\n`);
      }
    }
    process.stderr.write(`\nHarvest added ${keptRuns} run(s), ${keptFailures} failure(s).\n`);
    return 0;
  }

  if (command === 'status') {
    const runs = await loadRuns(corpusDir);
    const status = await gateZeroStatus(corpusDir, runs);
    if (json) {
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    } else {
      process.stdout.write(formatGateZeroStatus(status) + '\n');
    }
    return 0;
  }

  if (command === 'frames') {
    let runs = await loadRuns(corpusDir);
    // Default to the committed corpus: a published number must be one a reader
    // can reproduce from a clone, not one that depends on this working tree.
    if (!flags.has('include-untracked')) {
      const tracked = await committedRuns(process.cwd(), runs);
      if (tracked.length !== runs.length && !json) {
        process.stderr.write(
          `note: ${runs.length - tracked.length} run(s) on disk are not committed ` +
            `and are excluded. Pass --include-untracked to measure them too.\n`,
        );
      }
      runs = tracked;
    }
    const report = frameReport(runs);
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (flags.has('markdown')) {
      process.stdout.write(frameReportMarkdown(report) + '\n');
    } else {
      process.stdout.write(formatFrameReport(report) + '\n');
    }
    return 0;
  }

  if (command === 'scan') {
    const reposFlag = flags.get('repos');
    if (typeof reposFlag !== 'string') {
      process.stderr.write(
        'Error: scan needs --repos <file> (one owner/name per line).\n' +
          'It downloads a couple of the smallest candidate artifacts per repository\n' +
          'and checks they actually parse, which is the question harvest will ask.\n',
      );
      return 2;
    }
    const { readFile, writeFile } = await import('node:fs/promises');
    const repos = (await readFile(reposFlag, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    if (repos.length === 0) {
      process.stderr.write(`Error: ${reposFlag} lists no repositories.\n`);
      return 2;
    }

    const results: ProbeResult[] = [];
    for (const [i, repo] of repos.entries()) {
      if (!json) process.stderr.write(`[${i + 1}/${repos.length}] ${repo}\n`);
      results.push(
        await probeRepo(repo, {
          ...(flags.has('runs') ? { runsToProbe: Number(flags.get('runs')) } : {}),
          ...(flags.has('downloads')
            ? { maxDownloadsPerRun: Number(flags.get('downloads')) }
            : {}),
          ...(json
            ? {}
            : {
                onProgress: (line: string) => {
                  process.stderr.write(line + '\n');
                },
              }),
        }),
      );
    }

    const productive = results.filter((r) => r.productive);
    const outFlag = flags.get('out');
    if (typeof outFlag === 'string') {
      await writeFile(outFlag, productive.map((r) => r.repo).join('\n') + '\n', 'utf8');
      process.stderr.write(`wrote ${productive.length} repo(s) to ${outFlag}\n`);
    }

    if (json) {
      process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
      return 0;
    }

    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    const downloaded = results.reduce((n, r) => n + r.bytesDownloaded, 0);
    process.stdout.write(
      `\n${productive.length} of ${results.length} repositories yield parseable failures\n` +
        `downloaded ${mb(downloaded)} MB across ` +
        `${results.reduce((n, r) => n + r.artifactsDownloaded, 0)} artifact(s)\n\n`,
    );
    for (const r of productive) {
      process.stdout.write(
        `  ${r.repo}  ${r.failuresFound} failure(s) via ${r.adapters.join(', ')}\n`,
      );
    }
    const reasons = new Map<string, number>();
    for (const r of results) {
      if (r.productive) continue;
      const key = (r.reason ?? 'unknown').replace(/\(.*\)/, '(...)');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    if (reasons.size > 0) {
      process.stdout.write('\nnot productive:\n');
      for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`  ${String(n).padStart(4)}  ${reason}\n`);
      }
    }
    return 0;
  }

  if (command === 'sample') {
    let runs = await loadRuns(corpusDir);
    // Committed runs only, by default. A labelling sample that points at runs
    // the repository does not ship cannot be reproduced by whoever reviews the
    // resulting numbers.
    if (!flags.has('include-untracked')) {
      const tracked = await committedRuns(process.cwd(), runs);
      if (tracked.length !== runs.length && !json && !flags.has('ids')) {
        process.stderr.write(
          `note: ${runs.length - tracked.length} run(s) on disk are not committed ` +
            `(licence held) and are excluded from the sample.\n`,
        );
      }
      runs = tracked;
    }
    const opts: Parameters<typeof sampleForLabelling>[1] = {};
    if (flags.has('target')) opts.targetFailures = Number(flags.get('target'));
    if (flags.has('min-failures')) opts.minFailures = Number(flags.get('min-failures'));
    if (flags.has('max-failures')) opts.maxFailures = Number(flags.get('max-failures'));
    if (flags.has('max-per-repo')) opts.maxRunsPerRepo = Number(flags.get('max-per-repo'));
    if (flags.has('seed')) opts.seed = Number(flags.get('seed'));
    if (flags.has('slice')) opts.sliceLargeRuns = Number(flags.get('slice'));
    const result = sampleForLabelling(runs, opts);
    const selectionFlag = flags.get('selection');
    const selectionPath = typeof selectionFlag === 'string' ? selectionFlag : undefined;
    if (selectionPath !== undefined) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        selectionPath,
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            digest: result.digest,
            policy: result.policy,
            runs: result.runs.map((r) => ({
              corpusRunId: r.corpusRunId,
              ...(r.failureIds === undefined ? {} : { failureIds: r.failureIds }),
            })),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      process.stderr.write(`wrote selection to ${selectionPath}\n`);
    }
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (flags.has('ids')) {
      // Plain ids, so this can be piped straight into `label --only`. A sliced
      // run cannot be expressed this way — use --selection, which carries the
      // exact failures — so say so rather than silently labelling the whole run.
      if (result.slicedRuns > 0) {
        process.stderr.write(
          `warning: ${result.slicedRuns} selected run(s) are slices; --ids loses that ` +
            `and would label the whole run. Use --selection <file> with ` +
            `\`label --selection\` instead.\n`,
        );
      }
      for (const r of result.runs) process.stdout.write(r.corpusRunId + '\n');
    } else {
      process.stdout.write(formatSample(result) + '\n');
    }
    return 0;
  }

  if (command === 'worksheet') {
    const selFlag = flags.get('selection');
    const outFlag = flags.get('out');
    if (typeof selFlag !== 'string' || typeof outFlag !== 'string') {
      process.stderr.write('Error: worksheet needs --selection <file> and --out <file>.\n');
      return 2;
    }
    const ctx = flags.get('context') === 'payload-only' ? 'payload-only' : 'full';
    const { readFile, writeFile } = await import('node:fs/promises');
    const selection = JSON.parse(await readFile(selFlag, 'utf8')) as Parameters<
      typeof buildWorksheet
    >[1];
    const runs = await loadRuns(corpusDir);
    const { worksheet, key } = buildWorksheet(runs, selection, ctx);
    const keyPath = outFlag.replace(/\.json$/, '') + '.key.json';
    await writeFile(outFlag, JSON.stringify(worksheet, null, 2) + '\n', 'utf8');
    await writeFile(keyPath, JSON.stringify(key, null, 2) + '\n', 'utf8');
    const n = worksheet.entries.length;
    process.stdout.write(
      `wrote ${n} entr${n === 1 ? 'y' : 'ies'} to ${outFlag} (context: ${ctx})\n` +
        `key written to ${keyPath}\n` +
        (ctx === 'payload-only'
          ? 'The worksheet carries NO repository, workflow or commit — not even in an ' +
            'id — because that is the separability condition. The key file maps entries ' +
            'back; do not open it while labelling.\n'
          : '') +
        `Fill in "group" and "category" for each, then:\n` +
        `  corpus import --file ${outFlag} --labeler <your-name>\n`,
    );
    return 0;
  }

  if (command === 'import') {
    const fileFlag = flags.get('file');
    const labeler = flags.get('labeler');
    if (typeof fileFlag !== 'string' || typeof labeler !== 'string') {
      process.stderr.write('Error: import needs --file <file> and --labeler <name>.\n');
      return 2;
    }
    const { readFile } = await import('node:fs/promises');
    const { saveLabels } = await import('./label.ts');
    // The key sits beside the worksheet unless told otherwise. A full-context
    // worksheet does not need it; a payload-only one cannot be imported without it.
    const keyFlag = flags.get('key');
    const keyPath =
      typeof keyFlag === 'string' ? keyFlag : fileFlag.replace(/\.json$/, '') + '.key.json';
    let keyFile;
    try {
      keyFile = JSON.parse(await readFile(keyPath, 'utf8')) as Parameters<typeof parseWorksheet>[3];
    } catch {
      keyFile = undefined;
    }
    let result;
    try {
      result = parseWorksheet(
        JSON.parse(await readFile(fileFlag, 'utf8')),
        labeler,
        new Date().toISOString(),
        keyFile,
      );
    } catch (e) {
      process.stderr.write(`Error: ${(e as Error).message}\n`);
      return 2;
    }
    if (result.filled === 0) {
      process.stderr.write(
        `Error: ${fileFlag} has no filled entries — every group and category is blank.\n`,
      );
      return 2;
    }
    for (const rl of result.labels) await saveLabels(corpusDir, rl);
    process.stdout.write(
      `imported ${result.filled} label(s) across ${result.labels.length} run(s) as ` +
        `${labeler} (context: ${result.context})\n` +
        (result.blank > 0
          ? `${result.blank} entr${result.blank === 1 ? 'y is' : 'ies are'} still blank and were skipped\n`
          : '') +
        `Next: corpus baseline --labeler ${labeler}\n`,
    );
    return 0;
  }

  if (command === 'label') {
    const labeler = flags.get('labeler');
    if (typeof labeler !== 'string') {
      process.stderr.write(
        'Error: label needs --labeler. Each labeler writes to their own directory; ' +
          'that separation is what makes inter-labeler agreement measurable.\n',
      );
      return 3;
    }
    const context = String(flags.get('context') ?? 'full');
    if (context !== 'full' && context !== 'payload-only') {
      process.stderr.write(`Error: --context must be "full" or "payload-only", got ${context}.\n`);
      return 3;
    }
    const opts: Parameters<typeof labelCommand>[0] = { corpusDir, labeler, context };
    if (flags.has('min-failures')) opts.minFailures = Number(flags.get('min-failures'));
    if (flags.has('max-failures')) opts.maxFailures = Number(flags.get('max-failures'));
    const selFlag = flags.get('selection');
    if (typeof selFlag === 'string') {
      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(selFlag, 'utf8')) as {
        runs?: { corpusRunId?: string; failureIds?: string[] }[];
      };
      const map = new Map<string, Set<string> | null>();
      for (const entry of parsed.runs ?? []) {
        if (typeof entry.corpusRunId !== 'string') continue;
        map.set(
          entry.corpusRunId,
          Array.isArray(entry.failureIds) ? new Set(entry.failureIds) : null,
        );
      }
      if (map.size === 0) {
        process.stderr.write(`Error: ${selFlag} names no runs.\n`);
        return 2;
      }
      opts.selection = map;
    }
    if (flags.has('max-runs')) opts.maxRuns = Number(flags.get('max-runs'));
    return labelCommand(opts);
  }

  if (command === 'agreement') {
    const a = flags.get('a');
    const b = flags.get('b');
    if (typeof a !== 'string' || typeof b !== 'string') {
      const known = await listLabelers(corpusDir);
      process.stderr.write(
        `Error: agreement needs --a and --b.${
          known.length > 0 ? ` Known labelers: ${known.join(', ')}.` : ' No labelers yet.'
        }\n`,
      );
      return 3;
    }
    const report = await agreementReport(corpusDir, a, b);
    process.stdout.write(
      (json ? JSON.stringify(report, null, 2) : formatAgreement(report)) + '\n',
    );
    return report.failuresCompared === 0 ? 2 : 0;
  }

  if (command === 'separability') {
    const full = flags.get('full');
    const payload = flags.get('payload');
    if (typeof full !== 'string' || typeof payload !== 'string') {
      process.stderr.write('Error: separability needs --full and --payload labeler names.\n');
      return 3;
    }
    const report = await separabilityReport(corpusDir, full, payload);
    process.stdout.write(
      (json ? JSON.stringify(report, null, 2) : formatSeparability(report)) + '\n',
    );
    return report.compared === 0 ? 2 : 0;
  }

  if (command === 'baseline') {
    const labeler = flags.get('labeler');
    if (typeof labeler !== 'string') {
      const known = await listLabelers(corpusDir);
      process.stderr.write(
        `Error: baseline needs --labeler (whose labels to score against).${
          known.length > 0 ? ` Known: ${known.join(', ')}.` : ' No labelers yet.'
        }\n`,
      );
      return 3;
    }
    const runs = await loadRuns(corpusDir);
    const labels = await loadLabelerIndex(corpusDir, labeler, runs);
    if (labels.size === 0) {
      process.stderr.write(
        `Error: ${labeler} has no labels in ${corpusDir}. The baseline spike is only ` +
          'meaningful against human labels; there is nothing to score.\n',
      );
      return 2;
    }
    const report = runBaseline(runs, labels, { labeler });
    process.stdout.write(
      (json ? JSON.stringify(report, null, 2) : formatBaselineReport(report)) + '\n',
    );
    return report.runsScored === 0 ? 2 : 0;
  }

  process.stderr.write(`Error: unknown command ${JSON.stringify(command)}.\n\n${usage()}\n`);
  return 3;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(3);
  },
);

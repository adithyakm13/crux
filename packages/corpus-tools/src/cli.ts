#!/usr/bin/env node
/**
 * `corpus` — Gate 0 tooling. Not the product CLI; this is how the evidence gets
 * collected and how the gate numbers get computed.
 *
 *   corpus harvest --repos <file|list>   pull real failed CI runs into corpus/
 *   corpus status                        what the corpus contains vs Gate 0
 *   corpus frames                        app-frame availability per framework
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
    '  corpus status',
    '  corpus frames [--markdown] [--include-untracked]',
    '  corpus label --labeler <name> [--context full|payload-only]',
    '                [--min-failures N] [--max-failures N]',
    '  corpus agreement --a <labeler> --b <labeler>',
    '  corpus separability --full <labeler> --payload <labeler>',
    '  corpus baseline --labeler <name>',
    '',
    'Options:',
    '  --corpus DIR        corpus directory (default: ./corpus)',
    '  --runs-per-repo N   failed runs to examine per repository (default: 30)',
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

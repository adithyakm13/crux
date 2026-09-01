/**
 * GitHub Actions access for the corpus harvester.
 *
 * Shells out to `gh` rather than reimplementing auth. `execFile` with an
 * argument array is used everywhere — never a shell string — so nothing that
 * comes back from the API can be interpreted as a command.
 *
 * Note on retention: Actions artifacts expire (many busy repos keep them for
 * only a day or two), so a harvest only ever sees a recent window. Reaching the
 * Gate 0 run count means running the harvester repeatedly over time, not once.
 * `harvest` is idempotent on corpusRunId so re-running is safe.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Artifact zips can be tens of megabytes; give gh room but not unbounded. */
const MAX_BUFFER = 256 * 1024 * 1024;

export interface WorkflowRun {
  id: string;
  runAttempt: number;
  headSha: string | null;
  headBranch: string | null;
  event: string | null;
  workflowName: string | null;
  createdAt: string;
  url: string;
  conclusion: string | null;
}

export interface ArtifactRef {
  id: string;
  name: string;
  sizeInBytes: number;
  expired: boolean;
}

export class GitHubError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(`${message}. Fix: ${remedy}`);
    this.name = 'GitHubError';
    this.remedy = remedy;
  }
}

async function gh(args: string[], opts: { binary?: boolean } = {}): Promise<Buffer | string> {
  try {
    const { stdout } = await run('gh', args, {
      maxBuffer: MAX_BUFFER,
      encoding: opts.binary ? 'buffer' : 'utf8',
    });
    return stdout as Buffer | string;
  } catch (e) {
    const err = e as { code?: string; stderr?: string | Buffer; message: string };
    if (err.code === 'ENOENT') {
      throw new GitHubError('the `gh` CLI is not installed', 'install GitHub CLI from cli.github.com');
    }
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    if (/gh auth login|authentication/i.test(stderr)) {
      throw new GitHubError(`gh is not authenticated: ${stderr}`, 'run `gh auth login`');
    }
    throw new GitHubError(
      `gh ${args.slice(0, 2).join(' ')} failed: ${stderr.slice(0, 400)}`,
      'check the repository name and your access to it',
    );
  }
}

export async function repoMeta(
  repo: string,
): Promise<{
  stars: number;
  archived: boolean;
  licenseSpdx: string | null;
  /** Exactly what GitHub said, so NOASSERTION stays distinguishable from absent. */
  licenseRaw: string | null;
  pushedAt: string;
}> {
  const out = (await gh([
    'api',
    `repos/${repo}`,
    '--jq',
    '{stars: .stargazers_count, archived: .archived, license: (.license.spdx_id // null), pushedAt: .pushed_at}',
  ])) as string;
  const j = JSON.parse(out) as {
    stars: number;
    archived: boolean;
    license: string | null;
    pushedAt: string;
  };
  // GitHub reports "NOASSERTION" for a LICENSE file it cannot identify. That is
  // not a licence, and treating it as one is how unlicensed text ends up in a
  // committed corpus.
  const spdx = j.license === null || j.license === 'NOASSERTION' ? null : j.license;
  return {
    stars: j.stars,
    archived: j.archived,
    licenseSpdx: spdx,
    licenseRaw: j.license,
    pushedAt: j.pushedAt,
  };
}

export async function listFailedRuns(repo: string, limit: number): Promise<WorkflowRun[]> {
  const out = (await gh([
    'api',
    `repos/${repo}/actions/runs?status=failure&per_page=${Math.min(limit, 100)}`,
    '--jq',
    '[.workflow_runs[] | {id: (.id|tostring), runAttempt: (.run_attempt // 1), ' +
      'headSha: .head_sha, headBranch: .head_branch, event: .event, ' +
      'workflowName: .name, createdAt: .created_at, url: .html_url, conclusion: .conclusion}]',
  ])) as string;
  return JSON.parse(out) as WorkflowRun[];
}

export async function listArtifacts(repo: string, runId: string): Promise<ArtifactRef[]> {
  const out = (await gh([
    'api',
    `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    '--jq',
    '[.artifacts[] | {id: (.id|tostring), name: .name, sizeInBytes: .size_in_bytes, expired: .expired}]',
  ])) as string;
  return JSON.parse(out) as ArtifactRef[];
}

export async function downloadArtifact(repo: string, artifactId: string): Promise<Buffer> {
  const buf = (await gh(['api', `repos/${repo}/actions/artifacts/${artifactId}/zip`], {
    binary: true,
  })) as Buffer;
  return buf;
}

export async function rateLimitRemaining(): Promise<number> {
  const out = (await gh(['api', 'rate_limit', '--jq', '.rate.remaining'])) as string;
  return Number(out.trim());
}

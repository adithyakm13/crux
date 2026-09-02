/**
 * Playwright adapter (§4).
 *
 * Two input shapes, because CI produces both:
 *
 *  - **JSON reporter** (`results.json`) — the public, stable reporter output.
 *  - **Blob report** (`report.jsonl`) — the sharded intermediate format that
 *    real workflows actually upload, one reporter event per line. It carries
 *    strictly more than the JSON reporter (per-attempt errors with source
 *    locations and snippets), which is why it is worth supporting despite being
 *    an internal format. Its `version` is checked and an unknown version is
 *    reported rather than guessed at.
 *
 * Hostile input, same rules as every adapter: hard caps, no path from the input
 * touches the filesystem, no value reaches a shell, and control characters are
 * left intact for normalization to handle rather than being interpreted.
 *
 * Streaming: **neither path streams.** Both materialise the whole input before
 * parsing, and both are bounded by an explicit size cap that fails with a clear
 * error rather than exhausting memory.
 *
 * The blob format is line-delimited and could in principle be streamed, but is
 * not: its suite tree arrives before the results, and attachments arrive as
 * their own events sometimes after the test they belong to, so a single forward
 * pass cannot assemble an attempt. The JSON reporter emits one document and
 * crux has no incremental JSON parser. An earlier version of this comment
 * claimed the blob path was streamed; it never was. Recorded in
 * docs/limitations.md, with the cap as the safe fallback.
 */

import {
  DEFAULT_PARSE_LIMITS,
  ParseError,
  type AssertionDetail,
  type Artifact,
  type AttemptStatus,
  type Capabilities,
  type ParseLimits,
  type ParseOptions,
  type RawAttempt,
  type RawFailure,
  type TestResultAdapter,
} from '@cruxci/core';

/**
 * Whole-document JSON is parsed in memory. 256 MiB is far above any real
 * Playwright report and far below anything that would exhaust a CI runner.
 */
export const MAX_MONOLITHIC_JSON_BYTES = 256 * 1024 * 1024;

/** Blob report versions this adapter understands. */
const SUPPORTED_BLOB_VERSIONS = new Set([1, 2]);

export class PlaywrightAdapter implements TestResultAdapter {
  readonly name = 'playwright';

  capabilities(): Capabilities {
    return {
      // Playwright errors carry message, stack, location and a source snippet,
      // but no separated expected/actual/operator triple.
      structuredAssertion: false,
      stdout: true,
      stderr: true,
      stackTrace: true,
      retries: true,
      attemptStartTime: true,
      durations: true,
      workerId: true,
      artifacts: true,
      skipped: true,
    };
  }

  async detect(path: string): Promise<number> {
    const { open } = await import('node:fs/promises');
    let fh;
    try {
      fh = await open(path, 'r');
    } catch {
      return 0;
    }
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      if (head.includes('"onBlobReportMetadata"')) return 0.99;
      if (/^\s*\{\s*"method"\s*:/.test(head)) return 0.8;
      if (/"suites"\s*:/.test(head) && /"config"\s*:/.test(head)) return 0.95;
      if (/"suites"\s*:/.test(head) && /"specs"\s*:/.test(head)) return 0.9;
      if (/^\s*\{/.test(head)) return 0.05;
      return 0;
    } finally {
      await fh.close();
    }
  }

  async *parse(
    input: ReadableStream<Uint8Array>,
    options: ParseOptions = {},
  ): AsyncIterable<RawAttempt> {
    const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS, ...options.limits };
    const decoder = new TextDecoder('utf-8');
    const chunks: string[] = [];
    let bytes = 0;
    let firstNonSpace = '';

    // Read enough to decide which shape this is, then commit to a strategy.
    // Both shapes need the whole input anyway: the blob format's suite tree
    // arrives before the results, and the JSON reporter is one document.
    for await (const chunk of input as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > Math.min(limits.maxBytes, MAX_MONOLITHIC_JSON_BYTES)) {
        throw new ParseError({
          code: 'SIZE_LIMIT',
          message: `Playwright report exceeded ${Math.min(limits.maxBytes, MAX_MONOLITHIC_JSON_BYTES)} bytes`,
          at: `${bytes} bytes read`,
          remedy:
            'crux does not yet parse Playwright JSON incrementally; use the blob ' +
            'reporter, or shard the run. See docs/limitations.md.',
        });
      }
      const text = decoder.decode(chunk, { stream: true });
      if (firstNonSpace === '') firstNonSpace = text.trimStart().slice(0, 1);
      chunks.push(text);
    }
    chunks.push(decoder.decode());
    const text = chunks.join('');

    if (text.trim() === '') return;

    const isBlob = /"method"\s*:/.test(text.slice(0, 4096));
    const attempts = isBlob ? parseBlob(text, options, limits) : parseJsonReport(text, options, limits);
    for (const a of attempts) yield a;
  }
}

// ---------------------------------------------------------------------------
// Blob report: one reporter event per line
// ---------------------------------------------------------------------------

interface BlobTestMeta {
  title: string;
  file: string | null;
  suitePath: string[];
  line: number | null;
}

function parseBlob(text: string, options: ParseOptions, limits: ParseLimits): RawAttempt[] {
  const warn = options.onWarning ?? (() => {});
  const shardIndex = options.shardIndex ?? 0;
  const meta = new Map<string, BlobTestMeta>();
  const attemptsSeen = new Map<string, number>();
  const attachmentsByResult = new Map<string, Artifact[]>();
  const out: RawAttempt[] = [];
  let lineNo = 0;

  // Attachments arrive as their own events, sometimes before the test ends.
  // Two passes over the already-materialised lines is cheaper than buffering
  // results waiting for attachments that may never come.
  const lines = text.split('\n');

  for (const line of lines) {
    lineNo++;
    if (line.trim() === '') continue;
    let event: { method?: string; params?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch (e) {
      if (options.skipInvalid !== true) {
        throw new ParseError({
          code: 'JSON_ERROR',
          message: `blob report line is not valid JSON: ${(e as Error).message}`,
          at: `line ${lineNo}`,
          remedy: 'the upload was probably truncated; re-run the job or use --skip-invalid.',
        });
      }
      warn({ code: 'JSON_ERROR', message: 'unparseable blob line', at: `line ${lineNo}` });
      continue;
    }
    const params = event.params ?? {};
    switch (event.method) {
      case 'onBlobReportMetadata': {
        const version = (params['version'] as number | undefined) ?? 0;
        if (!SUPPORTED_BLOB_VERSIONS.has(version)) {
          warn({
            code: 'BLOB_VERSION',
            message:
              `blob report version ${version} is newer than this build understands ` +
              `(${[...SUPPORTED_BLOB_VERSIONS].join(', ')}); fields may be missing`,
            at: `line ${lineNo}`,
          });
        }
        break;
      }
      case 'onProject': {
        const project = params['project'] as { suites?: unknown[] } | undefined;
        for (const suite of (project?.suites ?? []) as unknown[]) {
          collectBlobSuite(suite, [], meta, limits);
        }
        break;
      }
      case 'onAttach': {
        const resultId = params['resultId'] as string | undefined;
        const list = (params['attachments'] ?? []) as {
          name?: string;
          path?: string;
          contentType?: string;
        }[];
        if (resultId !== undefined) {
          attachmentsByResult.set(
            resultId,
            list.map((a) => toArtifact(a)),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  lineNo = 0;
  for (const line of lines) {
    lineNo++;
    if (line.trim() === '') continue;
    let event: { method?: string; params?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue; // already reported in the first pass
    }
    if (event.method !== 'onTestEnd') continue;
    const params = event.params ?? {};
    const test = params['test'] as { testId?: string } | undefined;
    const result = params['result'] as BlobResult | undefined;
    if (test?.testId === undefined || result === undefined) continue;

    const info = meta.get(test.testId);
    const attemptIndex = result.retry ?? attemptsSeen.get(test.testId) ?? 0;
    attemptsSeen.set(test.testId, attemptIndex + 1);

    out.push(
      toAttempt({
        shardIndex,
        title: info?.title ?? test.testId,
        suitePath: info?.suitePath ?? [],
        file: info?.file ?? null,
        attemptIndex,
        result,
        artifacts: attachmentsByResult.get(result.id ?? '') ?? [],
        limits,
      }),
    );
    if (out.length > limits.maxAttempts) {
      throw new ParseError({
        code: 'ATTEMPT_LIMIT',
        message: `blob report contains more than ${limits.maxAttempts} attempts`,
        at: `line ${lineNo}`,
        remedy: 'split the report, or raise the limit if this run is genuinely this large.',
      });
    }
  }
  return out;
}

/**
 * `depth` is the recursion depth, tracked separately from `path.length`.
 *
 * They are not the same thing: `path` only grows when a suite has a non-empty
 * title that differs from the file, so a tree of empty-titled suites recursed
 * without ever incrementing the guarded quantity. The guard never fired and the
 * failure mode was a raw RangeError — reproduced with 20,000 empty suites —
 * rather than the bounded ParseError every adapter promises.
 */
function collectBlobSuite(
  node: unknown,
  path: string[],
  meta: Map<string, BlobTestMeta>,
  limits: ParseLimits,
  depth = 0,
): void {
  if (typeof node !== 'object' || node === null) return;
  if (depth > limits.maxDepth) {
    throw new ParseError({
      code: 'DEPTH_LIMIT',
      message: `blob suite tree exceeded ${limits.maxDepth} levels`,
      at: null,
      remedy: 'this input is not a normal Playwright report; reject it.',
    });
  }
  const suite = node as {
    title?: string;
    location?: { file?: string };
    entries?: unknown[];
    suites?: unknown[];
    tests?: unknown[];
  };
  const title = suite.title ?? '';
  const file = suite.location?.file ?? null;
  // Playwright titles the outermost suite with the spec file path. That path is
  // already carried by `filePath`, so repeating it as a suite segment would
  // double-count it and make suite paths differ from the JSON reporter's.
  const nextPath = title === '' || title === file ? path : [...path, title];

  for (const entry of [
    ...(suite.entries ?? []),
    ...(suite.suites ?? []),
    ...(suite.tests ?? []),
  ]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as {
      testId?: string;
      title?: string;
      location?: { file?: string; line?: number };
      entries?: unknown[];
    };
    if (typeof e.testId === 'string') {
      meta.set(e.testId, {
        title: e.title ?? '',
        // The suite title is the spec file path for the top-level suite, so the
        // location is the reliable source for the file.
        file: e.location?.file ?? file,
        suitePath: nextPath,
        line: e.location?.line ?? null,
      });
    } else {
      collectBlobSuite(entry, nextPath, meta, limits, depth + 1);
    }
  }
}

interface BlobResult {
  id?: string;
  duration?: number;
  status?: string;
  retry?: number;
  workerIndex?: number;
  startTime?: string;
  errors?: { message?: string; stack?: string; location?: { file?: string; line?: number } }[];
  error?: { message?: string; stack?: string };
  stdout?: unknown[];
  stderr?: unknown[];
  attachments?: { name?: string; path?: string; contentType?: string }[];
}

// ---------------------------------------------------------------------------
// JSON reporter
// ---------------------------------------------------------------------------

function parseJsonReport(text: string, options: ParseOptions, limits: ParseLimits): RawAttempt[] {
  const shardIndex = options.shardIndex ?? 0;
  let doc: { suites?: unknown[] };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch (e) {
    throw new ParseError({
      code: 'JSON_ERROR',
      message: `Playwright JSON report is not valid JSON: ${(e as Error).message}`,
      at: null,
      remedy: 'check whether the reporter was killed before writing the file.',
    });
  }
  const out: RawAttempt[] = [];
  for (const suite of doc.suites ?? []) {
    walkJsonSuite(suite, [], null, out, shardIndex, limits);
  }
  return out;
}

/** `depth` rather than `path.length`; see collectBlobSuite for why. */
function walkJsonSuite(
  node: unknown,
  path: string[],
  inheritedFile: string | null,
  out: RawAttempt[],
  shardIndex: number,
  limits: ParseLimits,
  depth = 0,
): void {
  if (typeof node !== 'object' || node === null) return;
  if (depth > limits.maxDepth) {
    throw new ParseError({
      code: 'DEPTH_LIMIT',
      message: `Playwright suite tree exceeded ${limits.maxDepth} levels`,
      at: null,
      remedy: 'this input is not a normal Playwright report; reject it.',
    });
  }
  const suite = node as {
    title?: string;
    file?: string;
    suites?: unknown[];
    specs?: unknown[];
  };
  const file = suite.file ?? inheritedFile;
  // The outermost suite title is the spec file path, which is already carried
  // by `file`; repeating it in the suite path would double-count it.
  const title = suite.title ?? '';
  const nextPath = title === '' || title === file ? path : [...path, title];

  for (const spec of suite.specs ?? []) {
    const s = spec as {
      title?: string;
      file?: string;
      tests?: { results?: BlobResult[]; projectName?: string }[];
    };
    for (const test of s.tests ?? []) {
      const results = test.results ?? [];
      for (const [i, result] of results.entries()) {
        out.push(
          toAttempt({
            shardIndex,
            title: s.title ?? '',
            suitePath: test.projectName ? [test.projectName, ...nextPath] : nextPath,
            file: s.file ?? file,
            attemptIndex: result.retry ?? i,
            result,
            artifacts: (result.attachments ?? []).map(toArtifact),
            limits,
          }),
        );
        if (out.length > limits.maxAttempts) {
          throw new ParseError({
            code: 'ATTEMPT_LIMIT',
            message: `report contains more than ${limits.maxAttempts} attempts`,
            at: null,
            remedy: 'split the report, or raise the limit.',
          });
        }
      }
    }
  }
  for (const child of suite.suites ?? []) {
    walkJsonSuite(child, nextPath, file, out, shardIndex, limits, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Shared conversion
// ---------------------------------------------------------------------------

function toAttempt(args: {
  shardIndex: number;
  title: string;
  suitePath: string[];
  file: string | null;
  attemptIndex: number;
  result: BlobResult;
  artifacts: Artifact[];
  limits: ParseLimits;
}): RawAttempt {
  const { result, limits } = args;
  const status = toStatus(result.status);
  const failure =
    status === 'failed' || status === 'error' || status === 'timed_out'
      ? toFailure(result, args.artifacts, limits)
      : null;
  return {
    shardIndex: args.shardIndex,
    displayName: clip(args.title, limits.maxNameBytes),
    suitePath: args.suitePath.map((s) => clip(s, limits.maxNameBytes)),
    filePath: args.file,
    attemptIndex: args.attemptIndex,
    status,
    durationMs: typeof result.duration === 'number' ? result.duration : null,
    startedAt: typeof result.startTime === 'string' ? result.startTime : null,
    workerId: typeof result.workerIndex === 'number' ? String(result.workerIndex) : null,
    failure,
  };
}

function toStatus(status: string | undefined): AttemptStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timed_out';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      // Interrupted means the run was cut short, not that the test failed.
      // Calling it `error` keeps it out of the failure population where it
      // would look like a real defect.
      return 'error';
    default:
      return 'error';
  }
}

function toFailure(result: BlobResult, artifacts: Artifact[], limits: ParseLimits): RawFailure {
  const errors = result.errors ?? (result.error ? [result.error] : []);
  const primary = errors[0] ?? {};
  const message = clip(primary.message ?? '', limits.maxTextBytesPerField);
  // Additional errors are appended rather than dropped: a test that failed for
  // three reasons is not the same failure as one that failed for one.
  const extra = errors
    .slice(1)
    .map((e) => e.message ?? '')
    .filter((m) => m !== '');
  const stack = errors
    .map((e) => e.stack)
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join('\n');

  return {
    errorType: inferErrorType(message),
    message: extra.length === 0 ? message : `${message}\n[+${extra.length} more error(s)]`,
    stackText: stack === '' ? null : clip(stack, limits.maxTextBytesPerField),
    stdout: joinIo(result.stdout, limits),
    stderr: joinIo(result.stderr, limits),
    // See capabilities(): Playwright does not separate expected from actual.
    assertion: null as AssertionDetail | null,
    artifacts,
  };
}

/**
 * Playwright puts the error class at the head of the message (`Error: …`,
 * `TimeoutError: …`). Reading it there is exact when present and null when not;
 * guessing a class from the prose would be fabrication.
 */
function inferErrorType(message: string): string | null {
  // The optional prefix matters: a bare `Error:` is the most common form of
  // all, and a pattern that requires a prefix silently returns null for it.
  const m = /^((?:[A-Z][A-Za-z0-9_]*)?(?:Error|Exception|Failure))\s*:/.exec(message.trimStart());
  return m === null ? null : m[1]!;
}

function joinIo(io: unknown[] | undefined, limits: ParseLimits): string | null {
  if (io === undefined || io.length === 0) return null;
  const parts: string[] = [];
  for (const entry of io) {
    if (typeof entry === 'string') parts.push(entry);
    else if (typeof entry === 'object' && entry !== null) {
      const e = entry as { text?: string; buffer?: string };
      if (typeof e.text === 'string') parts.push(e.text);
      // `buffer` is base64 binary output. Decoding it into a text field would
      // produce mojibake that normalization then hashes; note it instead.
      else if (typeof e.buffer === 'string') parts.push('[binary output omitted]');
    }
  }
  const joined = parts.join('');
  return joined === '' ? null : clip(joined, limits.maxTextBytesPerField);
}

function toArtifact(a: { name?: string; path?: string; contentType?: string }): Artifact {
  const name = a.name ?? '';
  const kind: Artifact['kind'] = /screenshot/i.test(name)
    ? 'screenshot'
    : /video/i.test(name)
      ? 'video'
      : /trace/i.test(name)
        ? 'trace'
        : /log|stdout|stderr/i.test(name)
          ? 'log'
          : 'other';
  return { kind, path: a.path ?? name, mediaType: a.contentType ?? null };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[crux: truncated at ${max} bytes]`;
}

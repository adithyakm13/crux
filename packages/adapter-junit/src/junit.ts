/**
 * JUnit XML adapter (§4).
 *
 * Input is hostile. Test results come from CI, which runs code from pull
 * requests, so every byte here is attacker-controlled:
 *
 *  - DOCTYPE is rejected outright. That closes XXE and billion-laughs at the
 *    door rather than relying on a resolver hook being wired correctly.
 *  - No external entity is ever resolved; only the five predefined entities and
 *    numeric character references, which cannot expand recursively.
 *  - Hard caps on bytes, depth, attributes per element, text per field, name
 *    length and total attempts. Each is a clear error, never an OOM.
 *  - Nothing parsed here is used as a filesystem path or passed to a shell.
 *  - ANSI escape sequences and XML-illegal control characters are removed from
 *    the byte stream before parsing, and counted. ESC is not a legal XML 1.0
 *    character, yet real producers emit it, so a strict parser would reject
 *    reports that real runners really write. See sanitize.ts for why this is
 *    not an information loss for analysis.
 *
 * Streaming: one chunk in, a bounded number of attempts out. Nothing
 * accumulates across the file except the single testcase currently open.
 */

import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { flushSanitize, newSanitizeState, sanitizeChunk } from './sanitize.ts';
import {
  DEFAULT_PARSE_LIMITS,
  ParseError,
  type Capabilities,
  type ParseLimits,
  type ParseOptions,
  type RawAttempt,
  type RawFailure,
  type TestResultAdapter,
  type AttemptStatus,
} from '@cruxci/core';

/**
 * Separator for the duplicate-testcase key. A real NUL, which the sanitizer
 * strips from every parsed value, so no attacker-supplied suite or test name
 * can contain it. This was previously written as an escaped literal, so the
 * separator was the seven characters `\u0000` — trivially reproducible in a
 * test name, which let distinct testcases collide into fabricated retries.
 */
const KEY_SEP = '\u0000';

/** Plain (non-namespaced) mode: JUnit uses no namespaces and xmlns adds attack surface. */
type SaxOpts = { xmlns: false; fragment: false; position: true };

/** Surefire's rerun extension. These are the only retry signal JUnit XML carries. */
const RERUN_ELEMENTS = new Set([
  'rerunfailure',
  'rerunerror',
  'flakyfailure',
  'flakyerror',
]);

const TEXT_ELEMENTS = new Set([
  'failure',
  'error',
  'skipped',
  'system-out',
  'system-err',
  'stacktrace',
  ...RERUN_ELEMENTS,
]);

interface OpenTestCase {
  name: string;
  classname: string | null;
  file: string | null;
  durationMs: number | null;
  /** Terminal outcomes seen on this testcase, in document order. */
  outcomes: { status: AttemptStatus; failure: RawFailure | null }[];
  /** Retry attempts from surefire rerun/flaky elements, in document order. */
  reruns: { status: AttemptStatus; failure: RawFailure }[];
  stdout: string | null;
  stderr: string | null;
}

interface TextSink {
  element: string;
  chunks: string[];
  bytes: number;
  attrs: Record<string, string>;
}

export class JUnitAdapter implements TestResultAdapter {
  readonly name = 'junit';

  capabilities(): Capabilities {
    return {
      // JUnit has no expected/actual/operator fields. Some producers stuff a
      // diff into the message; extracting it is normalization's problem, and a
      // guess either way, so the format is reported as unable to supply it.
      structuredAssertion: false,
      stdout: true,
      stderr: true,
      stackTrace: true,
      // Base JUnit cannot express a retry. Surefire's rerun elements can, and
      // are parsed when present, but a producer that cannot emit them would
      // otherwise look like "no retries happened" — which is a fabricated
      // finding. Downstream must treat absence as uninformative.
      retries: false,
      // Only the suite carries a timestamp, and it is frequently absent or
      // wrong. Per-attempt start time is not available.
      attemptStartTime: false,
      durations: true,
      workerId: false,
      artifacts: false,
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
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      if (!head.includes('<')) return 0;
      const hasSuites = /<\s*testsuites[\s>]/i.test(head);
      const hasSuite = /<\s*testsuite[\s>]/i.test(head);
      const hasCase = /<\s*testcase[\s>]/i.test(head);
      if (hasSuites && (hasSuite || hasCase)) return 0.95;
      if (hasSuite && hasCase) return 0.9;
      if (hasSuites || hasSuite) return 0.75;
      // An XML file that is not obviously JUnit. Low but non-zero: the first
      // 4 KiB may be a long <properties> block before the first testcase.
      if (/^\s*<\?xml/.test(head)) return 0.1;
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
    const shardIndex = options.shardIndex ?? 0;
    const warn = options.onWarning ?? (() => {});

    const parser = new SaxesParser<SaxOpts>({ xmlns: false, fragment: false, position: true });

    // ---- parse state -------------------------------------------------------
    const suiteStack: { name: string; file: string | null }[] = [];
    // Held in an object: these are written from saxes callbacks, and TypeScript's
    // control-flow analysis cannot see closure writes to a plain `let`.
    const st: { openCase: OpenTestCase | null; sink: TextSink | null } = {
      openCase: null,
      sink: null,
    };
    let depth = 0;
    let emitted = 0;
    let fatal: ParseError | null = null;
    /** Attempt index per (suitePath|classname|name), for duplicate testcases. */
    const seen = new Map<string, number>();
    let pending: RawAttempt[] = [];

    const at = () => `line ${parser.line}, column ${parser.column}`;

    const fail = (code: string, message: string, remedy: string): never => {
      throw new ParseError({ code, message, at: at(), remedy });
    };

    parser.on('error', (e) => {
      // saxes reports recoverable-looking problems through the same channel as
      // structural breakage. Neither is safe to guess past, so both are fatal
      // unless the caller asked to skip invalid input.
      if (options.skipInvalid) {
        warn({ code: 'XML_ERROR', message: e.message, at: at() });
        return;
      }
      fatal ??= new ParseError({
        code: 'XML_ERROR',
        message: `malformed XML: ${e.message}`,
        at: at(),
        remedy:
          'check whether the test runner was killed before writing the file. ' +
          'Ignore this file with --skip-invalid.',
      });
    });

    parser.on('doctype', () => {
      // Non-negotiable: a DOCTYPE is the delivery vehicle for both XXE and
      // entity-expansion denial of service. There is no legitimate JUnit
      // producer that needs one.
      fatal ??= new ParseError({
        code: 'XXE_DOCTYPE',
        message: 'XML declares a DOCTYPE, which crux refuses to process',
        at: at(),
        remedy:
          'remove the <!DOCTYPE> declaration. crux rejects it because DOCTYPE ' +
          'enables external entity and entity-expansion attacks.',
      });
    });

    parser.on('opentag', (tag: SaxesTagPlain) => {
      if (fatal) return;
      depth++;
      if (depth > limits.maxDepth) {
        fail(
          'DEPTH_LIMIT',
          `XML nesting exceeded ${limits.maxDepth} levels`,
          `raise --limit-depth if this input is genuinely this deep, ` +
            `otherwise treat the file as hostile.`,
        );
      }
      const attrCount = Object.keys(tag.attributes).length;
      if (attrCount > limits.maxAttributesPerElement) {
        fail(
          'ATTR_LIMIT',
          `element <${tag.name}> has ${attrCount} attributes, over the ${limits.maxAttributesPerElement} cap`,
          'this input is not a normal JUnit report; reject it.',
        );
      }

      const name = tag.name.toLowerCase();
      const attrs = lowerKeys(tag.attributes);

      if (name === 'testsuite') {
        const suiteName = clip(attrs['name'] ?? '', limits.maxNameBytes);
        suiteStack.push({ name: suiteName, file: attrs['file'] ?? null });
        return;
      }

      if (name === 'testcase') {
        if (st.openCase) {
          // Nested testcase is not valid JUnit; flush the outer one rather than
          // losing it.
          warn({ code: 'NESTED_TESTCASE', message: 'testcase nested in testcase', at: at() });
          pending.push(...finishCase(st.openCase));
        }
        st.openCase = {
          name: clip(attrs['name'] ?? '', limits.maxNameBytes),
          // Every attribute is attacker-controlled and unbounded. The text-node
          // path is capped in handleText; a cap enforced on one branch and not
          // the other is not a cap.
          classname: clipOrNull(attrs['classname'], limits.maxNameBytes),
          file: clipOrNull(attrs['file'] ?? suiteStack.at(-1)?.file, limits.maxNameBytes),
          durationMs: parseTime(attrs['time']),
          outcomes: [],
          reruns: [],
          stdout: null,
          stderr: null,
        };
        return;
      }

      if (TEXT_ELEMENTS.has(name)) {
        if (st.sink) {
          // e.g. <stackTrace> inside <rerunFailure>. Keep the outer st.sink's text
          // and let the inner element's text append into it.
          return;
        }
        st.sink = { element: name, chunks: [], bytes: 0, attrs };
      }
    });

    const handleText = (t: string): void => {
      if (fatal || !st.sink) return;
      if (st.sink.bytes >= limits.maxTextBytesPerField) return; // already clipped
      st.sink.bytes += t.length;
      if (st.sink.bytes > limits.maxTextBytesPerField) {
        const keep = t.length - (st.sink.bytes - limits.maxTextBytesPerField);
        st.sink.chunks.push(t.slice(0, Math.max(0, keep)));
        st.sink.chunks.push(`\n[crux: truncated at ${limits.maxTextBytesPerField} bytes]`);
        warn({
          code: 'TEXT_TRUNCATED',
          message: `<${st.sink.element}> text exceeded ${limits.maxTextBytesPerField} bytes`,
          at: at(),
        });
        return;
      }
      st.sink.chunks.push(t);
    };

    parser.on('text', handleText);
    // CDATA carries the stack trace in most producers. Route it through the
    // same sink and the same cap as ordinary text.
    parser.on('cdata', handleText);

    parser.on('closetag', (tag: SaxesTagPlain) => {
      if (fatal) return;
      depth--;
      const name = tag.name.toLowerCase();

      if (st.sink && st.sink.element === name) {
        const text = st.sink.chunks.join('');
        const a = st.sink.attrs;
        if (st.openCase) applyText(st.openCase, name, a, text);
        st.sink = null;
        return;
      }

      if (name === 'testcase') {
        if (st.openCase) {
          pending.push(...finishCase(st.openCase));
          st.openCase = null;
        }
        return;
      }

      if (name === 'testsuite') {
        suiteStack.pop();
      }
    });

    function applyText(
      tc: OpenTestCase,
      element: string,
      attrs: Record<string, string>,
      text: string,
    ): void {
      const message = attrs['message'] ?? '';
      const type = attrs['type'] ?? null;
      switch (element) {
        case 'failure':
        case 'error':
          tc.outcomes.push({
            status: element === 'error' ? 'error' : 'failed',
            failure: buildFailure(message, type, text),
          });
          return;
        case 'skipped':
          tc.outcomes.push({ status: 'skipped', failure: null });
          return;
        case 'system-out':
          tc.stdout = text === '' ? tc.stdout : text;
          return;
        case 'system-err':
          tc.stderr = text === '' ? tc.stderr : text;
          return;
        default:
          if (RERUN_ELEMENTS.has(element)) {
            tc.reruns.push({
              status: element.endsWith('error') ? 'error' : 'failed',
              failure: buildFailure(message, type, text),
            });
          }
      }
    }

    function buildFailure(message: string, type: string | null, text: string): RawFailure {
      // `message` and `type` arrive as XML attributes, which bypass the text
      // sink and therefore its size cap entirely.
      if (message.length > limits.maxTextBytesPerField) {
        warn({
          code: 'TEXT_TRUNCATED',
          message: `failure @message exceeded ${limits.maxTextBytesPerField} bytes`,
          at: at(),
        });
      }
      message = clip(message, limits.maxTextBytesPerField);
      type = type === null ? null : clip(type, limits.maxNameBytes);
      // The message attribute and the element text overlap in most producers;
      // keep both rather than picking, and let normalization decide (§5).
      const msg = message.trim() !== '' ? message : firstLine(text);
      return {
        errorType: type,
        message: msg,
        stackText: text.trim() === '' ? null : text,
        stdout: null,
        stderr: null,
        assertion: null, // JUnit cannot supply one; see capabilities().
        artifacts: [],
      };
    }

    function finishCase(tc: OpenTestCase): RawAttempt[] {
      const suitePath = suiteStack.map((s) => s.name).filter((s) => s !== '');
      if (tc.classname && tc.classname !== '' && !suitePath.includes(tc.classname)) {
        suitePath.push(tc.classname);
      }
      // NUL separator: it cannot occur in a suite or test name, so the composite
      // key is unambiguous where a space or dot would not be.
      const key = suitePath.join(KEY_SEP) + KEY_SEP + tc.name;
      const base = seen.get(key) ?? 0;

      // Surefire records reruns oldest-first, then the final outcome on the
      // testcase itself. Preserve that order: retries are evidence, not noise.
      const sequence: { status: AttemptStatus; failure: RawFailure | null }[] = [
        ...tc.reruns,
        ...(tc.outcomes.length > 0 ? tc.outcomes : [{ status: 'passed' as AttemptStatus, failure: null }]),
      ];

      const out: RawAttempt[] = [];
      for (let i = 0; i < sequence.length; i++) {
        const step = sequence[i]!;
        const failure = step.failure
          ? { ...step.failure, stdout: tc.stdout, stderr: tc.stderr }
          : null;
        out.push({
          shardIndex,
          displayName: tc.name,
          suitePath,
          filePath: tc.file,
          attemptIndex: base + i,
          status: step.status,
          // Duration is reported for the testcase as a whole. Attributing it to
          // the final attempt and leaving retries null is honest; splitting it
          // evenly would be invented data.
          durationMs: i === sequence.length - 1 ? tc.durationMs : null,
          startedAt: null,
          workerId: null,
          failure,
        });
      }
      const total = base + sequence.length;
      if (base > 0) {
        warn({
          code: 'DUPLICATE_TESTCASE',
          message:
            `testcase "${tc.name}" appears more than once in this file; ` +
            `recorded as attempt ${base}+ rather than collapsed`,
          at: at(),
        });
      }
      seen.set(key, total);
      emitted += out.length;
      if (emitted > limits.maxAttempts) {
        fail(
          'ATTEMPT_LIMIT',
          `file contains more than ${limits.maxAttempts} attempts`,
          'split the report, or raise the limit if this run is genuinely this large.',
        );
      }
      return out;
    }

    // ---- drive the stream --------------------------------------------------
    const decoder = new TextDecoder('utf-8');
    const sanitizer = newSanitizeState();
    let bytes = 0;
    try {
      for await (const chunk of input as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > limits.maxBytes) {
          throw new ParseError({
            code: 'SIZE_LIMIT',
            message: `input exceeded ${limits.maxBytes} bytes`,
            at: `${bytes} bytes read`,
            remedy: 'split the report into per-shard files, or raise --limit-bytes.',
          });
        }
        parser.write(sanitizeChunk(sanitizer, decoder.decode(chunk, { stream: true })));
        if (fatal) throw fatal;
        if (pending.length > 0) {
          const batch = pending;
          pending = [];
          yield* batch;
        }
      }
      const tail = sanitizeChunk(sanitizer, decoder.decode()) + flushSanitize(sanitizer);
      if (tail !== '') parser.write(tail);
      parser.close();
      if (fatal) throw fatal;
    } catch (e) {
      if (fatal) throw fatal;
      throw e;
    }

    if (sanitizer.ansiRemoved > 0 || sanitizer.controlsDropped > 0) {
      warn({
        code: 'CONTROL_CHARS_STRIPPED',
        message:
          `removed ${sanitizer.ansiRemoved} ANSI escape sequence(s) and ` +
          `${sanitizer.controlsDropped} XML-illegal control character(s); ` +
          `these are not valid XML 1.0 characters`,
        at: null,
      });
    }

    if (st.openCase) {
      // Truncated file: the runner died mid-write. Surface what we have and say so.
      warn({
        code: 'TRUNCATED_INPUT',
        message: `file ended with <testcase "${st.openCase.name}"> still open`,
        at: at(),
      });
      pending.push(...finishCase(st.openCase));
    }
    if (pending.length > 0) yield* pending;
  }
}

function lowerKeys(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[k.toLowerCase()] = v;
  return out;
}

function clipOrNull(s: string | null | undefined, max: number): string | null {
  return s === null || s === undefined ? null : clip(s, max);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function firstLine(s: string): string {
  const t = s.trim();
  const nl = t.indexOf('\n');
  return nl === -1 ? t : t.slice(0, nl);
}

function parseTime(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

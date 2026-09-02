/**
 * Stack frame parsing and classification (§6).
 *
 * The deepest `app` frame is the single most stable and most causally
 * meaningful signal in a stack trace. A stack of 40 frames where 38 are
 * framework noise should fingerprint on the 2 that matter, so classification
 * has to happen before hashing rather than after.
 *
 * Parsing covers the shapes crux actually meets in CI: V8/Node, Python,
 * JVM, Go and Ruby. A line that matches none of them is kept as an
 * unparsed frame with kind `unknown` rather than discarded — losing frames
 * silently would change fingerprints for reasons no user could see.
 */

import type { FrameKind, StackFrame } from '@cruxci/core';

export interface FrameClassifierOptions {
  /**
   * Globs identifying test files. Defaults cover the conventions of the
   * frameworks in scope; a project can override them from `.crux/config.yml`.
   */
  testGlobs?: string[];
  /** Extra directory names that mean "not our code". */
  vendorDirs?: string[];
}

export const DEFAULT_TEST_GLOBS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
  '**/e2e/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.py',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*IT.java',
  '**/*_spec.rb',
];

const VENDOR_DIRS = [
  'node_modules',
  'site-packages',
  'dist-packages',
  'vendor',
  '.venv',
  'venv',
  '.tox',
  '.gradle',
  '.m2',
  'go/pkg/mod',
];

/**
 * Runner packages. A frame inside one of these is framework machinery even when
 * it is not under a vendor directory — which happens when the runner is
 * developed in the same repository, and in bundled or transpiled output.
 */
const RUNNER_PATTERNS = [
  /(^|[/\\])playwright([/\\-]|$)/i,
  /(^|[/\\])@playwright([/\\]|$)/i,
  /(^|[/\\])jest([/\\-]|$)/i,
  /(^|[/\\])@jest([/\\]|$)/i,
  /(^|[/\\])vitest([/\\-]|$)/i,
  /(^|[/\\])mocha([/\\-]|$)/i,
  /(^|[/\\])jasmine([/\\-]|$)/i,
  /(^|[/\\])cypress([/\\-]|$)/i,
  /(^|[/\\])_pytest([/\\]|$)/,
  /(^|[/\\])pluggy([/\\]|$)/,
  /(^|[/\\])unittest([/\\.]|$)/,
  /^org\.junit\./,
  /^org\.testng\./,
  /^junit\./,
  /^testing\.(?:tRunner|runTests)/,
  /(^|[/\\])rspec([/\\-]|$)/i,
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `at fn (file:line:col)`, `at file:line:col`, `at fn (file)`. */
const V8 =
  /^\s*at\s+(?:(?<fn>[^()]+?)\s+\()?(?<file>[^()\s][^()]*?)(?::(?<line>\d+)(?::(?<col>\d+))?)?\)?\s*$/;
/** `File "path", line 42, in fn` */
const PY = /^\s*File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>\S+))?/;
/** `at pkg.Class.method(File.java:42)` */
const JVM =
  /^\s*at\s+(?<fn>[\w$.<>]+)\((?:(?<file>[\w$.-]+\.(?:java|kt|scala|groovy)):(?<line>\d+)|[^)]*)\)/;
/** `\tpath/file.go:42 +0x1a` */
/**
 * The `(?:[A-Za-z]:)?` prefix on the Go, Vitest and Ruby file groups admits a
 * Windows drive letter.
 *
 * Each of these bounds the file group with a class excluding `:` and anchors at
 * `^\s*`, so a `C:` prefix made the whole line match no parser at all and the
 * frame was silently discarded — on Windows only. The cross-platform
 * determinism gate in §6 would then fail for a reason unrelated to the failure
 * being fingerprinted. The V8 and pytest parsers were already unaffected: their
 * paths sit inside parentheses or quotes.
 */
const GO = /^\s*(?<file>(?:[A-Za-z]:)?[^\s:]+\.go):(?<line>\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;
/**
 * pytest's own failure format, which is not a traceback:
 *   `tests/test_orders.py:42: in test_charge`
 *   `tests/test_orders.py:42: AssertionError`
 * Without this, a pytest failure yields zero frames and the deepest-app-frame
 * signal — the most causally meaningful one there is — is simply unavailable
 * for an entire framework.
 */
const PYTEST =
  /^\s*(?<file>[^\s:][^:\n]*\.py):(?<line>\d+):\s*(?:in\s+(?<fn>\S+)|[A-Za-z_][\w.]*(?:Error|Exception|Failure|_)?)?\s*$/;
/**
 * Vitest's stack format: `❯ functionName file:line:col`, or with no
 * function name. Vitest emits JUnit XML like everything else, so without this
 * its frames are invisible and the deepest-app-frame signal is lost for every
 * project that uses it.
 */
const VITEST =
  /^\s*\u276f\s+(?:(?<fn>\S.*?)\s+)?(?<file>(?:[A-Za-z]:)?[^\s:]+):(?<line>\d+):(?<col>\d+)\s*$/;
/** `path/file.rb:42:in `method'` */
const RUBY = /^\s*(?:from\s+)?(?<file>(?:[A-Za-z]:)?[^\s:]+\.rb):(?<line>\d+):in\s+[`'](?<fn>[^'`]+)['`]/;

const PARSERS: [RegExp, string][] = [
  [PY, 'python'],
  // Before RUBY and V8, both of which would misread a `file.py:42: in fn` line.
  [PYTEST, 'pytest'],
  [JVM, 'jvm'],
  [RUBY, 'ruby'],
  [VITEST, 'vitest'],
  [V8, 'v8'],
  [GO, 'go'],
];

/**
 * Parse stack text into frames, in the order they appear. Callers get every
 * line that looks like a frame; prose lines (the exception message, `Caused
 * by:`, source excerpts) are dropped because they are not frames.
 */
export function parseStack(
  stackText: string | null,
  options: FrameClassifierOptions = {},
): StackFrame[] {
  if (stackText === null || stackText === '') return [];
  const frames: StackFrame[] = [];
  let pythonFrames = 0;
  // Split on all three line endings. CRLF happens to work when splitting on
  // \n because the trailing \r is trimmed off by each parser's `\s*$`, but a
  // classic-Mac CR-only stack collapses to a single line and parses zero
  // frames — the same failure would then fingerprint differently depending on
  // which machine produced the report, which is the exact drift §6 gates on.
  for (const raw of stackText.split(/\r\n|\r|\n/)) {
    if (raw.trim() === '') continue;
    const parsed = parseFrameLine(raw);
    if (parsed === null) continue;
    if (parsed.dialect === 'python' || parsed.dialect === 'pytest') pythonFrames++;
    frames.push({
      raw: parsed.raw,
      functionName: parsed.functionName,
      file: parsed.file,
      line: parsed.line,
      column: parsed.column,
      kind: classifyFrame(parsed.file, parsed.functionName, options),
    });
  }
  // Python prints tracebacks outermost-first ("most recent call last"), and
  // pytest prints its own failure sections in the same order, while
  // V8, the JVM, Go and Ruby all print innermost-first. Every consumer of this
  // list — deepestAppFrame above all — assumes innermost-first, so a Python
  // trace is reversed here rather than at each call site.
  if (pythonFrames > 0 && pythonFrames >= frames.length / 2) frames.reverse();
  return frames;
}

interface ParsedFrame {
  raw: string;
  dialect: string;
  functionName: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

function parseFrameLine(raw: string): ParsedFrame | null {
  for (const [re, dialect] of PARSERS) {
    const m = re.exec(raw);
    if (m === null || m.groups === undefined) continue;
    const g = m.groups;
    const file = g['file'] ?? null;
    // A V8 match with neither a file-looking token nor a line number is almost
    // always prose that happens to start with "at". Reject it rather than
    // polluting the frame list.
    if (re === V8 && file !== null && !/[/\\.]/.test(file)) return null;
    return {
      raw,
      dialect,
      functionName: normalizeFunctionName(g['fn'] ?? null),
      file,
      line: g['line'] !== undefined ? Number(g['line']) : null,
      column: g['col'] !== undefined ? Number(g['col']) : null,
    };
  }
  return null;
}

function normalizeFunctionName(fn: string | null): string | null {
  if (fn === null) return null;
  const t = fn.trim();
  if (t === '' || t === '<anonymous>') return null;
  // V8 prefixes: `async `, `new `, `Object.` on generated wrappers.
  return t.replace(/^(?:async|new)\s+/, '');
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyFrame(
  file: string | null,
  functionName: string | null,
  options: FrameClassifierOptions = {},
): FrameKind {
  if (file === null && functionName === null) return 'unknown';
  const path = (file ?? '').replace(/\\/g, '/');

  // Both the path and the qualified function name are examined. On the JVM the
  // package lives in the function name and the file is a bare `Foo.java`, so
  // checking only the path classifies `org.junit.runners.ParentRunner.run` as
  // application code — the exact frame that must be recognised as framework.
  const subjects = [path, functionName ?? ''].filter((x) => x !== '');
  if (subjects.length === 0) return 'unknown';

  const vendorDirs = [...VENDOR_DIRS, ...(options.vendorDirs ?? [])];
  for (const subject of subjects) {
    for (const dir of vendorDirs) {
      if (subject.includes(`/${dir}/`) || subject.startsWith(`${dir}/`)) return 'framework';
    }
    // Runtime and standard library frames are framework noise too.
    if (/^(?:node|internal):/.test(subject)) return 'framework';
    if (/^(?:java|javax|jdk|sun|kotlin|scala)\./.test(subject)) return 'framework';
    if (/^\/usr\/lib\/(?:python|jvm)/.test(subject)) return 'framework';
    for (const p of RUNNER_PATTERNS) {
      if (p.test(subject)) return 'framework';
    }
  }

  if (path !== '') {
    const globs = options.testGlobs ?? DEFAULT_TEST_GLOBS;
    for (const g of globs) {
      if (globMatch(g, path)) return 'test';
    }
    return 'app';
  }
  return 'unknown';
}

/**
 * The deepest `app` frame — the innermost frame in code the repository owns.
 * Frames are in innermost-first order for every runtime crux parses, so this is
 * the first `app` frame encountered.
 */
export function deepestAppFrame(frames: readonly StackFrame[]): StackFrame | null {
  return frames.find((f) => f.kind === 'app') ?? null;
}

export function appFrames(frames: readonly StackFrame[]): StackFrame[] {
  return frames.filter((f) => f.kind === 'app');
}

// ---------------------------------------------------------------------------
// Minimal glob matcher. Ten lines of regex beats a dependency here (§30); the
// subset supported is `**`, `*` and `?`, which is all the globs above use.
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

export function globMatch(glob: string, path: string): boolean {
  let re = globCache.get(glob);
  if (re === undefined) {
    re = new RegExp(globToRegExpSource(glob));
    globCache.set(glob, re);
  }
  return re.test(path);
}

function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      out += '(?:[^/]+/)*'; // zero or more path segments
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Unanchored at the start: a frame may carry an absolute prefix the glob
  // does not mention. Anchored at the end: a glob describes a whole path tail.
  return `(?:^|/)${out}$`;
}

/**
 * Normalization (§5). Deterministic, offline, versioned.
 *
 * Two outputs per failure: a **strict** normalization for exact matching and a
 * **loose** one for similarity. The split is load-bearing — strict keeps
 * "expected 5, got 7" distinct from "expected 5, got 9" because those are
 * different bugs; loose collapses them because they are the same broken
 * function. Clustering needs both.
 *
 * Every rule is individually toggleable and individually tested, so the
 * ablation table in docs/benchmarks.md can be produced by turning rules off
 * rather than by editing this file.
 *
 * Two properties are asserted by test, not by assertion in prose:
 *   - normalizing twice equals normalizing once
 *   - normalization never throws on any corpus input
 *
 * The second one is why every rule here is a plain regex replacement over a
 * bounded input and why none of them backtrack catastrophically.
 */

export type NormalizeMode = 'strict' | 'loose';

export interface NormalizeContext {
  /** Absolute repository root, so paths under it become repo-relative. */
  repoRoot?: string;
  /** Absolute home directory. Defaults to the running user's. */
  homeDir?: string;
}

export interface NormalizeRule {
  id: string;
  /** What it does and why, for `crux explain` and for the ablation table. */
  description: string;
  apply(text: string, mode: NormalizeMode, ctx: NormalizeContext): string;
}

/** Convenience for rules that are a single regex replacement in both modes. */
function sub(
  id: string,
  description: string,
  pattern: RegExp,
  replacement: string,
): NormalizeRule {
  return {
    id,
    description,
    apply: (text) => text.replace(pattern, replacement),
  };
}

/** Same, but only active in loose mode. */
function looseOnly(
  id: string,
  description: string,
  pattern: RegExp,
  replacement: string,
): NormalizeRule {
  return {
    id,
    description,
    apply: (text, mode) => (mode === 'loose' ? text.replace(pattern, replacement) : text),
  };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const ESC = '\\u001B';

/** ANSI CSI/OSC/two-char escapes, plus stray C0 controls other than tab/LF/CR. */
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-9;:?]*[ -/]*[@-~]|\\][^]*?(?:\\u0007|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
/** Crockford base32, 26 chars, starting with a valid timestamp digit. */
const ULID = /\b[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}\b/g;
/** Mongo ObjectId. 24 hex is also plausible as a short hash; both are noise. */
const OBJECT_ID = /\b[0-9a-f]{24}\b/gi;
/** Long bare hex: git shas, content hashes, opaque handles. */
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

const HEX_ADDR = /\b0x[0-9a-f]{4,}\b/gi;

const ISO_TS =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/g;
/**
 * Epoch seconds and milliseconds, bounded to a plausible range (2001-09-09 to
 * 2033-05-18). An unbounded `\d{10,13}` would eat ordinary large integers,
 * which are exactly the values an assertion is often about.
 */
const EPOCH_MS = /\b1[0-9]{12}\b/g;
const EPOCH_S = /\b1[0-9]{9}\b/g;

const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|m|h)\b/gi;

const PORT = /:\d{4,5}\b/g;

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Pragmatic IPv6: at least two groups and one `::` or six colons. */
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})\b/gi;

const TMP_PATH =
  /(?:\/private)?\/tmp\/[^\s'"`,;)\]]*|\/var\/folders\/[^\s'"`,;)\]]*|%TEMP%[^\s'"`,;)\]]*|[A-Za-z]:\\+(?:Users\\+[^\\\s]+\\+AppData\\+Local\\+Temp|Temp)\\+[^\s'"`,;)\]]*/gi;

const URL_QUERY = /(\bhttps?:\/\/[^\s'"`<>]*?)\?[^\s'"`<>]*/gi;
const URL_NUMERIC_SEGMENT = /(\bhttps?:\/\/[^\s'"`<>]*?)\/\d+(?=\/|\b)/gi;

/**
 * Generated identities. Deliberately narrower than "any email": a real email in
 * an assertion is signal, a seeded one is noise. The qualifier in the spec's
 * table is "generated", so the rule targets local parts that carry a counter or
 * a random blob, plus the reserved test domains.
 */
const GENERATED_EMAIL =
  /\b[A-Za-z0-9._%+-]*(?:\d{3,}|[0-9a-f]{8,})[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b[A-Za-z0-9._%+-]+@(?:example|test|invalid|localhost|mailinator|faker)\.[A-Za-z.]+\b/g;
const GENERATED_NAME = /\b(?:user|test|fixture|acct|account|tenant|org|customer)[-_]\d+\b/gi;

const WORKER_COUNTER =
  /\b(?:worker|shard|attempt|retry|thread|proc|process|job|chunk)[-_ ]?#?\d+\b/gi;

/** `file.ext:LINE:COL` or `file.ext:LINE`, the tail of a stack frame. */
const LINE_COL = /(\.[A-Za-z0-9]{1,6}):\d+(?::\d+)?\b/g;

/**
 * Assertion values, for loose mode. Covers the shapes the common runners emit.
 * Each alternative keeps the label and replaces only the value.
 */
/**
 * Assertion values, for loose mode.
 *
 * Only *recognised* expected/actual constructs are rewritten. An earlier
 * version also matched `assert…:` and `to be …` and replaced everything to the
 * end of the line, which on a real pytest corpus reduced whole messages to
 * `AssertionError: <val>` — every unrelated assertion failure collapsing into
 * one cluster. The label is kept and only the value is replaced.
 */
const ASSERTION_SHAPES: [RegExp, string][] = [
  [/\b(expected|Expected)\s*:\s*[^\n]{1,200}/g, '$1: <val>'],
  [/\b(received|Received|actual|Actual)\s*:\s*[^\n]{1,200}/g, '$1: <val>'],
  [
    /\bexpected\s+[^\n,]{1,120}?\s*,?\s*\b(?:but )?(?:got|received)\s+[^\n]{1,120}/gi,
    'expected <val>, got <val>',
  ],
];

/**
 * Literal values inside an assertion: quoted strings and bare numbers.
 *
 * This is what actually collapses "assert 0 >= 1" and "assert 3 >= 7" onto one
 * another while leaving the surrounding prose — which is the discriminative
 * part — intact. Kept as its own rule so the ablation table can measure whether
 * it earns its place rather than assuming it does.
 */
const QUOTED_LITERAL = /'[^'\n]{0,120}'|"[^"\n]{0,120}"|`[^`\n]{0,120}`/g;
const BARE_NUMBER = /(?<![\w<])-?\d+(?:\.\d+)?(?![\w>])/g;

const WHITESPACE = /[ \t\u00A0]{2,}/g;
const BLANK_LINES = /\n{3,}/g;

// ---------------------------------------------------------------------------
// Rules, in application order. Order matters and is part of the algorithm.
// ---------------------------------------------------------------------------

export const RULES: readonly NormalizeRule[] = [
  {
    id: 'ansi-control',
    description:
      'Strip ANSI escape sequences and C0 control characters. First, so no later ' +
      'rule has to reason about colour codes embedded in a path or a number.',
    apply: (text) => text.replace(ANSI, '').replace(CONTROL, ''),
  },
  sub('uuid', 'UUID v1-v8 to <id>.', UUID, '<id>'),
  sub('ulid', 'ULID to <id>.', ULID, '<id>'),
  sub('object-id', '24-character hex object ids to <id>.', OBJECT_ID, '<id>'),
  sub('long-hex', 'Git shas and content hashes (32+ hex chars) to <id>.', LONG_HEX, '<id>'),
  sub('hex-address', 'Hexadecimal memory addresses to <addr>.', HEX_ADDR, '<addr>'),
  sub('iso-timestamp', 'ISO-8601 timestamps to <ts>.', ISO_TS, '<ts>'),
  sub('epoch-ms', 'Epoch milliseconds in a plausible range to <ts>.', EPOCH_MS, '<ts>'),
  sub('epoch-s', 'Epoch seconds in a plausible range to <ts>.', EPOCH_S, '<ts>'),
  sub('duration', 'Durations with a unit suffix to <dur>.', DURATION, '<dur>'),
  {
    id: 'temp-path',
    description: 'Per-run temporary directories to <tmp>. Runs before path rules.',
    apply: (text) => text.replace(TMP_PATH, '<tmp>'),
  },
  {
    id: 'repo-path',
    description:
      'Absolute paths under the repository root become repo-relative, so the same ' +
      'failure on a developer machine and in CI normalizes identically.',
    apply: (text, _mode, ctx) => {
      const root = ctx.repoRoot;
      if (root === undefined || root === '') return text;
      const trimmed = root.endsWith('/') ? root.slice(0, -1) : root;
      return text.split(trimmed + '/').join('');
    },
  },
  {
    id: 'home-dir',
    description: 'Home directories to <home>.',
    apply: (text, _mode, ctx) => {
      const home = ctx.homeDir;
      let out = text;
      if (home !== undefined && home !== '') {
        out = out.split(home.endsWith('/') ? home.slice(0, -1) : home).join('<home>');
      }
      // Generic shapes, for payloads produced on a machine that is not this one.
      out = out.replace(/\/(?:home|Users)\/[^/\s'"`,;)\]]+/g, '<home>');
      out = out.replace(/[A-Za-z]:\\+Users\\+[^\\\s]+/g, '<home>');
      return out;
    },
  },
  sub('url-query', 'Drop URL query strings.', URL_QUERY, '$1'),
  sub('url-numeric-segment', 'Numeric URL path segments to <n>.', URL_NUMERIC_SEGMENT, '$1/<n>'),
  sub('port', 'Port numbers to :<port>.', PORT, ':<port>'),
  sub('ipv6', 'IPv6 literals to <ip>. Before IPv4 so mapped forms match whole.', IPV6, '<ip>'),
  sub('ipv4', 'IPv4 literals to <ip>.', IPV4, '<ip>'),
  sub('generated-email', 'Seeded or counter-bearing email addresses to <gen>.', GENERATED_EMAIL, '<gen>'),
  sub('generated-name', 'Counter-bearing fixture identities to <gen>.', GENERATED_NAME, '<gen>'),
  sub('worker-counter', 'Worker, shard, attempt and retry counters to <n>.', WORKER_COUNTER, '<n>'),
  looseOnly(
    'stack-line-col',
    'Drop line:col from stack frames. Strict keeps them: a different line in the ' +
      'same file is usually a different bug.',
    LINE_COL,
    '$1',
  ),
  {
    id: 'assertion-values',
    description:
      'Replace assertion expected/actual values with <val> in loose mode only. ' +
      'This is the rule that makes "expected 5, got 7" and "expected 5, got 9" ' +
      'cluster together while staying distinct under strict matching.',
    apply: (text, mode) => {
      if (mode !== 'loose') return text;
      let out = text;
      for (const [pattern, replacement] of ASSERTION_SHAPES) {
        out = out.replace(pattern, replacement);
      }
      return out;
    },
  },
  {
    id: 'assertion-literals',
    description:
      'Replace quoted strings and bare numbers with <val> in loose mode. This is ' +
      'what makes two failures of the same assertion with different data cluster ' +
      'together; strict keeps them apart, because different data can mean a ' +
      'different bug.',
    apply: (text, mode) => {
      if (mode !== 'loose') return text;
      return text.replace(QUOTED_LITERAL, '<val>').replace(BARE_NUMBER, '<val>');
    },
  },
  {
    id: 'whitespace',
    description: 'Collapse whitespace runs and trim. Last, so earlier rules see real layout.',
    apply: (text) =>
      text
        .replace(/\r\n?/g, '\n')
        .replace(WHITESPACE, ' ')
        .replace(BLANK_LINES, '\n\n')
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .trim(),
  },
];

const RULE_IDS = new Set(RULES.map((r) => r.id));

export interface NormalizeOptions extends NormalizeContext {
  /** Rule ids to skip. Used by the ablation table; unknown ids are an error. */
  disabled?: Iterable<string>;
}

export function normalize(
  text: string,
  mode: NormalizeMode,
  options: NormalizeOptions = {},
): string {
  const disabled = new Set(options.disabled ?? []);
  for (const id of disabled) {
    if (!RULE_IDS.has(id)) {
      throw new Error(
        `normalize: unknown rule ${JSON.stringify(id)}. Known rules: ${[...RULE_IDS].join(', ')}`,
      );
    }
  }
  const ctx: NormalizeContext = {};
  if (options.repoRoot !== undefined) ctx.repoRoot = options.repoRoot;
  if (options.homeDir !== undefined) ctx.homeDir = options.homeDir;

  let out = text;
  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue;
    out = rule.apply(out, mode, ctx);
  }
  return out;
}

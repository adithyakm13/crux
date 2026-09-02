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

/**
 * ANSI CSI/OSC/two-char escapes, plus stray C0 controls other than tab/LF/CR.
 *
 * The OSC branch excludes BEL and ESC from its body class and bounds its
 * length. Both matter. An unbounded lazy `[^]*?` has to try every extension
 * from every ESC position when no terminator follows, which is quadratic:
 * measured at 35 ms for 16 KiB of `ESC ]` and 8.4 s for 256 KiB, so a 1 MiB
 * failure message — inside the existing field cap — costs minutes of CPU on
 * input an attacker writes. Excluding the terminators makes the match
 * unambiguous, and the bound caps the scan; a longer OSC string is left alone
 * rather than scanned, which loses nothing real (no runner emits a 512-byte
 * window title into a stack trace).
 */
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-9;:?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]{0,512}(?:\\u0007|${ESC}\\\\)|[@-Z\\\\-_])`,
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

/**
 * Port numbers, anchored to an actual host context.
 *
 * A bare `:\d{4,5}` is not a port rule, it is a colon rule. It matched the line
 * number in every stack frame past line 999, so `src/a.ts:1234` and
 * `src/a.ts:5678` both normalized to `src/a.ts:<port>` — in STRICT mode, whose
 * entire job is to keep those distinct. Two unrelated failures in one file then
 * shared a strict fingerprint. Per the note at the top of fingerprint.ts that is
 * a normalization defect, and this was it.
 *
 * The anchor requires a host: an already-substituted `<ip>`, `localhost`, an
 * IPv6 bracket, or a URL authority. A bare `example.com:8080` in prose is
 * therefore left alone, because `.com` and `.ts` are not distinguishable
 * lexically. That is a deliberate false negative: under-normalizing splits a
 * cluster, over-normalizing merges two different bugs, and the second is worse.
 */
const PORT = /(?<=<ip>|\blocalhost|\]|\/\/[A-Za-z0-9._-]{1,253}):\d{2,5}\b(?!\.\d)/g;

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
 * Assertion values, for loose mode.
 *
 * Only a *value token* is replaced — a quoted string, a number, a literal, or a
 * single bare word. Never a span running to end of line.
 *
 * The earlier version matched `expected <anything>, got <anything>` and
 * replaced the whole span with `expected <val>, got <val>`. That collapsed
 * "expected user to be logged in, got anonymous" and "expected cart to be
 * empty, got 3 items" onto one string — unrelated failures sharing a loose
 * fingerprint, which §8 weights at 0.80 and would cluster together. The subject
 * of an assertion is the discriminative part; only the value is noise.
 *
 * The numeric alternative requires a trailing non-word boundary. Without it,
 * `got 550e8400-...` matched only the leading `550`, leaving a tail that the
 * bare-token alternative consumed on a second pass — a rule not idempotent on
 * its own, which the per-rule property test catches even though the cascade's
 * fixed point hides it.
 *
 * Note these shapes are largely redundant with `assertion-literals` below,
 * which already reduces "expected 200, got 500" to "expected <val>, got <val>"
 * via the bare-number pattern while leaving prose intact. They are kept for the
 * unquoted non-numeric case, and the ablation table can settle whether they
 * earn their place.
 */
const VALUE_TOKEN =
  String.raw`(?:'[^'\n]{0,120}'|"[^"\n]{0,120}"|` + '`' + String.raw`[^` + '`' + String.raw`\n]{0,120}` + '`' +
  String.raw`|[-+]?\d+(?:\.\d+)?(?![\w.])|true|false|null|undefined|NaN|\S{1,60})`;

const ASSERTION_SHAPES: [RegExp, string][] = [
  [new RegExp(String.raw`\b(expected|Expected)\s*:\s*` + VALUE_TOKEN, 'g'), '$1: <val>'],
  [
    new RegExp(String.raw`\b(received|Received|actual|Actual)\s*:\s*` + VALUE_TOKEN, 'g'),
    '$1: <val>',
  ],
  // Only the actual value, never the `expected …` subject that precedes it.
  [new RegExp(String.raw`\b(got|received)\s+` + VALUE_TOKEN, 'gi'), '$1 <val>'],
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
  {
    id: 'whitespace-canonical',
    description:
      'Normalise line endings and collapse runs of spaces/tabs to one space. ' +
      'Early, so every pattern rule below sees canonical spacing. When this ran ' +
      'last instead, "took 250  ms" kept its double space through the duration ' +
      'rule and normalised to "took 250 ms" while "took 250 ms" became ' +
      '"took <dur>" — two spellings of one timeout, two fingerprints, a split ' +
      'cluster caused by whitespace the pipeline was supposed to have removed.',
    apply: (text) => text.replace(/\r\n?/g, '\n').replace(WHITESPACE, ' '),
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
  sub('ipv6', 'IPv6 literals to <ip>. Before IPv4 so mapped forms match whole.', IPV6, '<ip>'),
  sub('ipv4', 'IPv4 literals to <ip>.', IPV4, '<ip>'),
  // After the IP rules: the port anchor keys off the `<ip>` they produce.
  sub('port', 'Port numbers to :<port>, only after a host.', PORT, ':<port>'),
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
    id: 'whitespace-trim',
    description:
      'Trim each line, then collapse blank-line runs, then trim the whole. Last. ' +
      'Per-line trimming must precede the blank-line collapse: a whitespace-only ' +
      'line only becomes blank once trimmed, so collapsing first leaves runs of ' +
      'newlines that a second pass would collapse again — non-idempotent.',
    apply: (text) =>
      text
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .replace(BLANK_LINES, '\n\n')
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

  // Run the cascade to a fixed point rather than exactly once.
  //
  // Individually idempotent rules do not compose into an idempotent cascade,
  // because one rule's output can create a match for a rule that already ran.
  // A real instance: `duration` only fires on `0m` when the next character is
  // not a word character, and `home-dir` — which runs later — rewrites
  // `C:\Users\x` to `<home>`, so a second pass over the same text produced
  // `<dur>` where the first produced `0m`. Two spellings of one failure, two
  // fingerprints, a silently split cluster.
  //
  // Reordering fixes that pair and leaves the next one to be discovered. A
  // fixed point makes the property hold by construction for any rule set, which
  // is what §5 actually requires: normalizing twice equals normalizing once.
  const active = RULES.filter((r) => !disabled.has(r.id));
  let out = text;
  for (let pass = 0; pass < MAX_NORMALIZE_PASSES; pass++) {
    let next = out;
    for (const rule of active) next = rule.apply(next, mode, ctx);
    if (next === out) return out;
    out = next;
  }
  // Not converged. Returning the last iterate keeps normalization total (§5:
  // it never throws on corpus input), and the property test asserts that this
  // branch is unreachable for any input it can generate.
  return out;
}

/**
 * Cap on cascade iterations. Convergence is normally reached on the second
 * pass — the first pass rewrites, the second confirms nothing changed. The cap
 * exists so that a pathological rule interaction degrades to a stable answer
 * instead of looping.
 */
export const MAX_NORMALIZE_PASSES = 8;

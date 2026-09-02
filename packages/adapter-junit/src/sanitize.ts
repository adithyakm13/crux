/**
 * XML character sanitizer for the JUnit adapter.
 *
 * Why this exists: real CI producers write raw ANSI escapes into JUnit XML.
 * Playwright, pytest and several Maven reporters all do it. ESC (U+001B) is not
 * a legal XML 1.0 character — not as a raw byte and not as `&#27;` — so a strict
 * parser rejects those files outright. Refusing to parse a report that a real
 * runner really produced is not a defensible position for a tool whose entire
 * job is reading CI output.
 *
 * So the byte stream is filtered before it reaches the parser:
 *
 *  1. Whole ANSI escape sequences are removed, not just the ESC byte. Removing
 *     ESC alone would leave `[2m` as literal text and defeat the ANSI rule in
 *     normalization (§5), which is specified to strip these anyway — so no
 *     information that analysis uses is lost here.
 *  2. Any remaining XML-illegal control character is dropped.
 *
 * Both are counted and reported as warnings. A silent lossy step is exactly the
 * kind of thing that makes fingerprints differ between machines for no visible
 * reason.
 *
 * Sequences split across chunk boundaries are held in a carry buffer, so the
 * result does not depend on how the stream happened to be chunked. That is
 * asserted as a property test, not just claimed here.
 */

const ESC = '\u001B';
const BEL = '\\u0007';

/**
 * Largest OSC body we will consume. Must stay below MAX_CARRY, so the carry
 * path never gives up on a sequence this regex would still have matched.
 */
const MAX_OSC_BODY = 512;

/**
 * CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and two-character escapes.
 *
 * Two properties matter here and both were learned the hard way.
 *
 * The OSC body class excludes BEL and ESC and is length-bounded. An unbounded
 * lazy `[^]*?` must try every extension from every ESC when no terminator
 * follows, which is quadratic — 8.4 s for 256 KiB of `ESC ]` on input a pull
 * request writes.
 *
 * The final branch consumes an *unterminated* OSC rather than leaving it. If
 * it is left, the two-character-escape branch strips only `ESC ]` and the body
 * survives into the byte stream — and the body is attacker-chosen text that
 * reaches the XML parser as markup. A body carrying `]]>` closes the enclosing
 * CDATA early and writes testcases that never ran into the corpus. Consuming
 * the body means a stray `ESC ]` eats up to 512 following characters, which is
 * correct: `ESC ]` *is* an OSC introducer, and no runner emits one it does not
 * mean.
 */
const ANSI = new RegExp(
  ESC +
    '(?:' +
    '\\[[0-9;:?]*[ -/]*[@-~]' + // CSI
    '|\\][^' +
    BEL +
    ESC +
    ']{0,' +
    MAX_OSC_BODY +
    '}(?:' +
    BEL +
    '|' +
    ESC +
    '\\\\)' + // OSC, BEL- or ST-terminated
    '|\\][^' +
    BEL +
    ESC +
    ']{0,' +
    MAX_OSC_BODY +
    '}' + // OSC with no terminator: consumed, never leaked
    '|[@-Z\\\\-_]' + // two-character escape
    ')',
  'g',
);

/**
 * Matches a tail that could still be extended into a complete escape sequence.
 *
 * This cannot be derived from ANSI by asking "did the tail match?". `ESC ]`
 * matches ANSI's two-character-escape branch in full, so a naive completeness
 * test declares it finished and shreds every OSC sequence that straddles a
 * chunk boundary. The prefix cases have to be spelled out.
 */
const PARTIAL = new RegExp(
  '^' +
    ESC +
    '(?:' +
    '\\[[0-9;:?]*[ -/]*' + // CSI with no final byte yet
    '|\\][^' +
    BEL +
    ESC +
    ']{0,' +
    MAX_OSC_BODY +
    '}' + // OSC with no terminator yet, bounded like the matcher
    '|' + // a bare ESC
    ')$',
);

/** C0 controls illegal in XML 1.0. Tab, LF and CR are legal and kept. */
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Longest carry we will hold waiting for an escape sequence to terminate.
 *
 * Strictly greater than MAX_OSC_BODY. If it were smaller, a sequence longer
 * than the carry but still matchable by ANSI would be carried in some chunkings
 * and not others, and the result would depend on how the stream was split —
 * which is exactly the property this module promises it does not.
 */
const MAX_CARRY = MAX_OSC_BODY + 16;

export interface SanitizeState {
  carry: string;
  ansiRemoved: number;
  controlsDropped: number;
}

export function newSanitizeState(): SanitizeState {
  return { carry: '', ansiRemoved: 0, controlsDropped: 0 };
}

/**
 * Filter one chunk. Returns the text safe to hand to the XML parser; anything
 * that might be the start of an escape sequence is retained in `state.carry`
 * for the next call. Call `flushSanitize` once the stream ends.
 */
export function sanitizeChunk(state: SanitizeState, chunk: string): string {
  let s = state.carry + chunk;
  state.carry = '';

  // Hold back a trailing partial escape sequence so chunking cannot change the
  // result. Any complete sequence earlier in the string is handled by `scrub`.
  const lastEsc = s.lastIndexOf(ESC);
  if (lastEsc !== -1) {
    const tail = s.slice(lastEsc);
    if (tail.length <= MAX_CARRY && PARTIAL.test(tail)) {
      state.carry = tail;
      s = s.slice(0, lastEsc);
    }
  }

  return scrub(state, s);
}

/** Emit whatever is left in the carry buffer. Call once, at end of stream. */
export function flushSanitize(state: SanitizeState): string {
  const rest = state.carry;
  state.carry = '';
  return rest === '' ? '' : scrub(state, rest);
}

function scrub(state: SanitizeState, s: string): string {
  if (s === '') return '';
  let out = s;
  if (out.includes(ESC)) {
    ANSI.lastIndex = 0;
    out = out.replace(ANSI, () => {
      state.ansiRemoved++;
      return '';
    });
  }
  // The common case is text with no control characters at all; skip the
  // second pass when there is nothing to drop.
  ILLEGAL.lastIndex = 0;
  if (ILLEGAL.test(out)) {
    ILLEGAL.lastIndex = 0;
    out = out.replace(ILLEGAL, () => {
      state.controlsDropped++;
      return '';
    });
  }
  return out;
}

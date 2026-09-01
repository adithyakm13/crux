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

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and two-character escapes. */
const ANSI = new RegExp(
  ESC +
    '(?:' +
    '\\[[0-9;:?]*[ -/]*[@-~]' + // CSI
    '|\\][^]*?(?:' +
    BEL +
    '|' +
    ESC +
    '\\\\)' + // OSC, BEL- or ST-terminated
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
    '|\\](?:(?!' +
    BEL +
    '|' +
    ESC +
    '\\\\)[^])*' + // OSC with no terminator yet
    '|' + // a bare ESC
    ')$',
);

/** C0 controls illegal in XML 1.0. Tab, LF and CR are legal and kept. */
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Longest carry we will hold waiting for an escape sequence to terminate.
 * An OSC sequence can legitimately be long; past this we give up and treat the
 * ESC as a stray control character rather than buffering without bound.
 */
const MAX_CARRY = 256;

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

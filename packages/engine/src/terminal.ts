/**
 * Terminal output sanitizer (§4).
 *
 * "Strip ANSI and control characters before anything is printed to a terminal —
 * terminal escape injection through a test name is real."
 *
 * This is a separate concern from normalization, and it belongs at the print
 * boundary rather than at ingest. The corpus deliberately stores raw payloads,
 * because normalization is specified to see them and because a corpus that has
 * already been scrubbed cannot be re-analysed under a new algorithm version.
 * The consequence is that anything rendering a stored payload is rendering
 * attacker-controlled bytes: 29 of 92 failures in the current corpus contain a
 * raw ESC, harvested from public repositories whose CI runs pull-request code.
 *
 * What escape sequences can do to a terminal, given the chance: reposition the
 * cursor to overwrite text that was already printed, clear the screen to hide
 * what came before, set the window or tab title, and — in several emulators —
 * drive OSC 52 to write the system clipboard. None of that should be reachable
 * from a test name.
 *
 * So every rendered field goes through here. The replacement is visible rather
 * than silent: a labeler needs to know the text was altered, otherwise they are
 * judging something other than what the runner produced.
 */

const ESC = '\u001B';

/**
 * ANSI escape sequences: CSI, OSC (bounded, both terminators), and the
 * two-character escapes. Bounded for the same reason as the ingest sanitizer —
 * an unbounded lazy body is quadratic on input that never terminates.
 */
const ANSI = new RegExp(
  ESC +
    '(?:' +
    '\\[[0-9;:?]*[ -/]*[@-~]' +
    '|\\][^\\u0007\\u001B]{0,512}(?:\\u0007|' +
    ESC +
    '\\\\)' +
    '|\\][^\\u0007\\u001B]{0,512}' +
    '|[@-Z\\\\-_]' +
    ')',
  'g',
);

/** C0 controls and DEL, excluding tab and newline which are legitimate layout. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Unicode direction overrides. These reorder how text *displays* without
 * changing the bytes, so a test name can be made to read as something other
 * than what it is — the "Trojan Source" trick. Rendered visibly rather than
 * dropped, because their presence is itself worth seeing.
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

export interface SanitizeTerminalOptions {
  /**
   * Marker substituted for each removed sequence. Empty string removes
   * silently; the default keeps the removal visible.
   */
  marker?: string;
}

/**
 * Make a string safe to write to a terminal.
 *
 * Newlines and tabs survive — callers are printing multi-line stack traces and
 * need them. Everything else that can move a cursor, repaint the screen, talk
 * to the terminal emulator, or reorder the display is removed.
 */
export function sanitizeForTerminal(s: string, options: SanitizeTerminalOptions = {}): string {
  const marker = options.marker ?? '';
  return (
    s
      // CRLF is a legitimate line ending from a Windows runner, so it folds to
      // LF rather than being stripped. A *bare* CR is different: it returns the
      // cursor to column 0 and overwrites the line already printed, which is
      // the cheapest way to hide text from a reader. It goes.
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, marker)
      .replace(ANSI, marker)
      .replace(CONTROL, marker)
      .replace(BIDI, '<bidi>')
  );
}

/** True when `s` contains anything `sanitizeForTerminal` would change. */
export function hasTerminalHazard(s: string): boolean {
  return sanitizeForTerminal(s) !== s;
}

/**
 * Fingerprinting (§6). No LLM, fully offline, deterministic across machines and
 * platforms.
 *
 *   strict = H( error_type ‖ strict_norm(message) ‖ top5(app_frames, with line) )
 *   loose  = H( error_type ‖ loose_norm(message)  ‖ top3(app_frames, no line)   )
 *
 * H is BLAKE3 with 128 bits retained. The identifier carries the algorithm
 * version — `fp_v1_<hex32>` — so a fingerprint produced by a different version
 * can never be silently compared against one produced by this version.
 *
 * A note on the collision gate: BLAKE3-128 will not collide at any scale this
 * system reaches. A collision between two distinct labelled root causes is
 * therefore always two distinct causes reducing to the same normalized string,
 * which is a defect in a normalization rule (§5) and must be investigated
 * there, never here.
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { FINGERPRINT_VERSION, asFingerprintId, type FingerprintId, type StackFrame } from '@cruxci/core';
import { normalize, type NormalizeOptions } from './normalize.ts';
import { appFrames, deepestAppFrame, parseStack, type FrameClassifierOptions } from './frames.ts';
import { minhash } from './minhash.ts';

/** Frames included in each hash. Deeper frames are the stable, causal ones. */
const STRICT_FRAMES = 5;
const LOOSE_FRAMES = 3;

/**
 * Unit separator between hash components. With a space, a message ending in a
 * path and an empty frame list could hash identically to a shorter message
 * followed by that path — a collision manufactured by the encoding rather than
 * by the data. U+001F cannot survive normalization, so no component contains it.
 */
const SEP = '\u001F';

export interface FingerprintInput {
  errorType: string | null;
  message: string;
  stackText: string | null;
}

export interface FingerprintOptions extends NormalizeOptions, FrameClassifierOptions {}

export interface FingerprintResult {
  id: FingerprintId;
  algoVersion: number;
  strictHash: string;
  looseHash: string;
  normalizedRepr: { strict: string; loose: string };
  /** Null when the loose message is too short to sketch; see minhash.ts. */
  minhash: Int32Array | null;
  frames: StackFrame[];
  deepestAppFrame: StackFrame | null;
  /**
   * True when the stack had no frame classified `app`, so the hash fell back to
   * the deepest frames of any kind. Reported rather than hidden: it changes how
   * much weight the shared-frame clustering signal deserves.
   */
  usedFrameFallback: boolean;
}

export function fingerprint(
  input: FingerprintInput,
  options: FingerprintOptions = {},
): FingerprintResult {
  const frames = parseStack(input.stackText, options);
  const app = appFrames(frames);
  // With no app frame at all there is nothing repo-specific to hash. Falling
  // back to the deepest frames of any kind keeps distinct framework failures
  // distinguishable; hashing nothing would collapse them into one bucket.
  const usedFrameFallback = app.length === 0 && frames.length > 0;
  const basis = app.length > 0 ? app : frames;

  // errorType is the JUnit `<failure type="...">` attribute, copied verbatim
  // from input the parser is explicitly told to treat as hostile. Unnormalized,
  // it can carry the separator itself and forge any serialization it likes.
  const errorType = normalize(input.errorType ?? '', 'strict', options);
  const strictMessage = normalize(input.message, 'strict', options);
  const looseMessage = normalize(input.message, 'loose', options);

  const strictHash = hash([
    errorType,
    strictMessage,
    ...basis.slice(0, STRICT_FRAMES).flatMap((f) => frameParts(f, true, options)),
  ]);
  const looseHash = hash([
    errorType,
    looseMessage,
    ...basis.slice(0, LOOSE_FRAMES).flatMap((f) => frameParts(f, false, options)),
  ]);

  return {
    id: asFingerprintId(`fp_v${FINGERPRINT_VERSION}_${strictHash}`),
    algoVersion: FINGERPRINT_VERSION,
    strictHash,
    looseHash,
    normalizedRepr: { strict: strictMessage, loose: looseMessage },
    minhash: minhash(looseMessage),
    frames,
    deepestAppFrame: deepestAppFrame(frames),
    usedFrameFallback,
  };
}

/**
 * Serialize one frame for hashing, as discrete parts rather than one joined
 * string.
 *
 * Path separators are folded to `/` and the path is run through the same
 * normalization as the message. Without both, the same failure fingerprints
 * differently on Windows and on Linux, and the cross-platform determinism gate
 * fails for a reason that has nothing to do with the failure.
 *
 * The parts are returned separately because joining them with `:` and `#` was
 * ambiguous: both characters occur freely in real file paths and in function
 * names (bundler wrappers, `Module#method` in transpiled output), so distinct
 * file/line/function triples serialized to the same bytes and collided. A
 * strict-hash collision is documented at the top of this file as always being a
 * normalization defect — which would have sent an investigator to the wrong
 * file entirely.
 */
function frameParts(
  frame: StackFrame,
  withLine: boolean,
  options: NormalizeOptions,
): string[] {
  const file =
    frame.file === null ? '' : normalize(frame.file.replace(/\\/g, '/'), 'strict', options);
  const fn = normalize(frame.functionName ?? '', 'strict', options);
  return withLine ? [file, String(frame.line ?? ''), fn] : [file, fn];
}

/**
 * Hash a list of components.
 *
 * Each component is length-prefixed. The separator alone is not enough: it
 * relies on no component ever containing it, which is a property of the
 * normalizer rather than of this function, and one that silently stops holding
 * the moment a component skips normalization. Length prefixes make the
 * serialization injective regardless.
 */
function hash(parts: readonly string[]): string {
  const framed = parts.map((p) => `${p.length}${SEP}${p}`).join(SEP);
  return bytesToHex(blake3(new TextEncoder().encode(framed), { dkLen: 16 }));
}

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

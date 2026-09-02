/**
 * Independent version lines (§29). These change at different rates and must
 * never be conflated. Every derived artifact records the version of the
 * algorithm that produced it, so rows from different versions are never
 * silently compared (§3).
 */

/** Wire/on-disk schema for anything serialized by crux. Readers accept N and N-1. */
export const SCHEMA_VERSION = 1 as const;

/** Bump when any normalization rule in §5 changes observable output. */
export const NORMALIZE_VERSION = 3 as const;

/** Bump when fingerprint hash inputs or frame classification change (§6). */
export const FINGERPRINT_VERSION = 3 as const;

/** Bump when clustering signals, weights, or partitioning change (§8). */
export const CLUSTER_VERSION = 1 as const;

/** Bump when classification rules change (§9). */
export const RULES_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * A reader accepts the current schema version and the one before it (§3).
 * Anything else is a hard error: silently reading an unknown shape is how
 * corrupt statistics enter the system.
 */
export function assertReadableSchema(v: unknown, context: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(
      `${context}: missing or non-integer schemaVersion (got ${JSON.stringify(v)}). ` +
        `Fix: re-generate this file with crux ${SCHEMA_VERSION >= 1 ? 'v0.1+' : ''}.`,
    );
  }
  if (v > SCHEMA_VERSION) {
    throw new Error(
      `${context}: schemaVersion ${v} is newer than this build supports (${SCHEMA_VERSION}). ` +
        `Fix: upgrade crux.`,
    );
  }
  if (v < SCHEMA_VERSION - 1) {
    throw new Error(
      `${context}: schemaVersion ${v} is older than the supported window ` +
        `(${SCHEMA_VERSION - 1}..${SCHEMA_VERSION}). Fix: re-generate this file.`,
    );
  }
}

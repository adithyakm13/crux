/**
 * Test result adapter interface (§4).
 *
 * `capabilities()` is load-bearing: JUnit XML has no structured assertion diff
 * and usually no stdout. Downstream analysis asks what is available rather than
 * assuming, and degrades rather than fabricating.
 */

import type { AssertionDetail, AttemptStatus, Artifact } from './domain.ts';

/**
 * What an adapter emits per parsed record. Deliberately flat and
 * identity-free: assigning `TestIdentityId` / `AttemptId` is ingestion's job
 * (§4), because it needs run context the adapter does not have.
 */
export interface RawAttempt {
  /** Shard this record came from; the caller supplies it, adapters default to 0. */
  shardIndex: number;
  displayName: string;
  suitePath: string[];
  filePath: string | null;
  /** 0 for the first execution. Retries increment. Never collapsed. */
  attemptIndex: number;
  status: AttemptStatus;
  durationMs: number | null;
  startedAt: string | null;
  workerId: string | null;
  failure: RawFailure | null;
}

export interface RawFailure {
  errorType: string | null;
  message: string;
  /** Unparsed stack text. Frame classification happens in fingerprinting (§6). */
  stackText: string | null;
  stdout: string | null;
  stderr: string | null;
  assertion: AssertionDetail | null;
  artifacts: Artifact[];
}

/**
 * Fields a format can supply at all. `false` means "this format cannot carry
 * it", which is different from "this run happened not to have one".
 */
export interface Capabilities {
  /** Structured expected/actual/operator rather than free text. */
  structuredAssertion: boolean;
  stdout: boolean;
  stderr: boolean;
  /** Per-attempt stack text. */
  stackTrace: boolean;
  /** Retries distinguishable from independent executions. */
  retries: boolean;
  /** Per-attempt wall-clock start, not just duration. */
  attemptStartTime: boolean;
  durations: boolean;
  workerId: boolean;
  artifacts: boolean;
  /** Skipped tests are reported rather than omitted. */
  skipped: boolean;
}

export interface ParseOptions {
  /** Shard index to stamp on every record from this input. */
  shardIndex?: number;
  /** Continue past malformed records instead of throwing (CLI `--skip-invalid`). */
  skipInvalid?: boolean;
  /** Called for every recoverable problem, even when skipInvalid is false. */
  onWarning?: (w: ParseWarning) => void;
  limits?: Partial<ParseLimits>;
}

export interface ParseWarning {
  code: string;
  message: string;
  /** Byte offset or line where known; null when the parser cannot say. */
  at: string | null;
}

/**
 * Hard caps (§4). Input arrives from CI, which runs pull request code, so every
 * byte is attacker-controlled. Exceeding a cap is a clear error, never an OOM.
 */
export interface ParseLimits {
  maxBytes: number;
  maxAttempts: number;
  maxDepth: number;
  maxAttributesPerElement: number;
  maxTextBytesPerField: number;
  maxNameBytes: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: 512 * 1024 * 1024,
  maxAttempts: 2_000_000,
  maxDepth: 64,
  maxAttributesPerElement: 256,
  maxTextBytesPerField: 1 * 1024 * 1024,
  maxNameBytes: 8 * 1024,
};

export interface TestResultAdapter {
  readonly name: string;
  /** 0..1 confidence that `path` (and a peek at its head) is this format. */
  detect(path: string): Promise<number>;
  parse(input: ReadableStream<Uint8Array>, options?: ParseOptions): AsyncIterable<RawAttempt>;
  capabilities(): Capabilities;
}

/** Thrown when input exceeds a hard cap or is unrecoverably malformed. */
export class ParseError extends Error {
  readonly code: string;
  readonly at: string | null;
  readonly remedy: string;

  constructor(args: { code: string; message: string; at?: string | null; remedy: string }) {
    // §17: an error states what happened, where, and what to do.
    super(
      `${args.message}${args.at ? ` at ${args.at}` : ''}. Fix: ${args.remedy}`,
    );
    this.name = 'ParseError';
    this.code = args.code;
    this.at = args.at ?? null;
    this.remedy = args.remedy;
  }
}

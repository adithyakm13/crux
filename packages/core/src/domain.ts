/**
 * Framework-neutral domain model (§3).
 *
 * No JUnit, Playwright, pytest or Cypress concept appears in this file. If a
 * field only makes sense for one framework it belongs in that adapter's
 * `capabilities()` surface, not here.
 *
 * Rules enforced by these types:
 *  - Every ID is explicit and stable. Nothing is identified by array position.
 *  - Every derived artifact carries the version of the algorithm that made it.
 *  - `Attempt` is the grain. Retries are separate attempts, never collapsed.
 */

// ---------------------------------------------------------------------------
// Branded identifiers. Prevents passing a run id where a test identity id goes.
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RepositoryId = Brand<string, 'RepositoryId'>;
export type TestIdentityId = Brand<string, 'TestIdentityId'>;
export type RunId = Brand<string, 'RunId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type FingerprintId = Brand<string, 'FingerprintId'>;
export type ClusterId = Brand<string, 'ClusterId'>;
export type EnvironmentId = Brand<string, 'EnvironmentId'>;
export type ComponentId = Brand<string, 'ComponentId'>;
export type AnalysisId = Brand<string, 'AnalysisId'>;
export type Sha = Brand<string, 'Sha'>;

/** Unsafe casts, colocated so every place identity is minted is greppable. */
export const asRepositoryId = (s: string) => s as RepositoryId;
export const asTestIdentityId = (s: string) => s as TestIdentityId;
export const asRunId = (s: string) => s as RunId;
export const asAttemptId = (s: string) => s as AttemptId;
export const asFingerprintId = (s: string) => s as FingerprintId;
export const asClusterId = (s: string) => s as ClusterId;
export const asEnvironmentId = (s: string) => s as EnvironmentId;
export const asComponentId = (s: string) => s as ComponentId;
export const asAnalysisId = (s: string) => s as AnalysisId;
export const asSha = (s: string) => s as Sha;

// ---------------------------------------------------------------------------
// Repository / VCS
// ---------------------------------------------------------------------------

export interface Repository {
  id: RepositoryId;
  remoteUrl: string;
  defaultBranch: string;
}

export interface Commit {
  sha: Sha;
  parents: Sha[];
  author: string;
  authoredAt: string; // ISO-8601 UTC
  message: string;
}

export interface Branch {
  name: string;
  headSha: Sha;
}

export interface PullRequest {
  number: number;
  headSha: Sha;
  baseSha: Sha;
  state: 'open' | 'closed' | 'merged';
}

// ---------------------------------------------------------------------------
// Test identity (§7)
// ---------------------------------------------------------------------------

export interface TestIdentity {
  id: TestIdentityId;
  repoId: RepositoryId;
  /** Stable key derived from (file_path, suite_path, display_name). */
  canonicalKey: string;
  displayName: string;
  filePath: string | null;
  suitePath: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export type AliasConfidence = 'high' | 'proposed';

/**
 * Renames are recorded as edges, never as merged rows, so every merge is
 * reversible and recomputation can walk the graph (§7).
 */
export interface TestAlias {
  fromIdentity: TestIdentityId;
  toIdentity: TestIdentityId;
  confidence: AliasConfidence;
  evidence: Evidence[];
  detectedAt: string;
  /** null until a human accepts it via `crux identity review`. */
  confirmedBy: string | null;
}

// ---------------------------------------------------------------------------
// Runs and attempts
// ---------------------------------------------------------------------------

export type RunTrigger = 'push' | 'pull_request' | 'schedule' | 'manual' | 'local' | 'unknown';

export interface Run {
  id: RunId;
  repoId: RepositoryId | null;
  commitSha: Sha | null;
  branch: string | null;
  prNumber: number | null;
  trigger: RunTrigger;
  startedAt: string | null;
  finishedAt: string | null;
  environmentId: EnvironmentId | null;
  shardCount: number;
}

export interface RunShard {
  runId: RunId;
  shardIndex: number;
  machineId: string | null;
  /**
   * Estimated offset of this shard's clock from the run coordinator's, in ms.
   * Any temporal analysis uses corrected time; any conclusion that would flip
   * under 30s of skew is not reported (§4).
   */
  clockOffsetMs: number;
}

export type AttemptStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'timed_out';

export interface Attempt {
  id: AttemptId;
  runId: RunId;
  shardIndex: number;
  testIdentityId: TestIdentityId;
  /** 0 for the first execution; retries increment. Never collapsed. */
  attemptIndex: number;
  status: AttemptStatus;
  durationMs: number | null;
  startedAt: string | null;
  workerId: string | null;
}

export interface AssertionDetail {
  expected: string | null;
  actual: string | null;
  operator: string | null;
}

export interface Artifact {
  kind: 'screenshot' | 'video' | 'trace' | 'log' | 'other';
  path: string;
  mediaType: string | null;
}

export interface Failure {
  attemptId: AttemptId;
  /** Framework-reported exception/error class, e.g. `AssertionError`. */
  errorType: string | null;
  message: string;
  stack: StackFrame[];
  stdout: string | null;
  stderr: string | null;
  assertion: AssertionDetail | null;
  artifacts: Artifact[];
}

/**
 * Frames are classified before hashing (§6). The deepest `app` frame is the
 * single most causally meaningful signal in a stack trace.
 */
export type FrameKind = 'test' | 'framework' | 'app' | 'unknown';

export interface StackFrame {
  raw: string;
  functionName: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  kind: FrameKind;
}

// ---------------------------------------------------------------------------
// Derived artifacts. Each carries the algorithm version that produced it.
// ---------------------------------------------------------------------------

export interface Fingerprint {
  id: FingerprintId; // fp_v{N}_{hex32}
  algoVersion: number;
  strictHash: string;
  looseHash: string;
  normalizedRepr: { strict: string; loose: string };
  /** MinHash signature over character 5-grams; null when the message is too short (§6). */
  minhash: number[] | null;
}

export interface Cluster {
  id: ClusterId;
  runId: RunId;
  algoVersion: number;
  memberCount: number;
  signalsUsed: string[];
}

export interface ClusterMember {
  clusterId: ClusterId;
  attemptId: AttemptId;
  edgeWeightToCentroid: number;
}

export type Category =
  | 'PRODUCT_REGRESSION'
  | 'TEST_DEFECT'
  | 'FLAKY'
  | 'ENVIRONMENT_FAILURE'
  | 'DEPENDENCY_FAILURE'
  | 'DATA_FAILURE'
  | 'PERFORMANCE_REGRESSION'
  | 'UNKNOWN';

export const CATEGORIES: readonly Category[] = [
  'PRODUCT_REGRESSION',
  'TEST_DEFECT',
  'FLAKY',
  'ENVIRONMENT_FAILURE',
  'DEPENDENCY_FAILURE',
  'DATA_FAILURE',
  'PERFORMANCE_REGRESSION',
  'UNKNOWN',
] as const;

export interface Evidence {
  /** Stable id an AI claim can reference; unresolvable ids are dropped (§19). */
  id: string;
  rule: string;
  detail: string;
}

/**
 * Buckets, not percentages. A percentage is banned until a reliability curve
 * and Brier score exist for it (§9).
 */
export type EvidenceStrength = 'strong' | 'moderate' | 'weak';

export interface Classification {
  subject: { kind: 'failure'; attemptId: AttemptId } | { kind: 'cluster'; clusterId: ClusterId };
  category: Category;
  evidence: Evidence[];
  counterEvidence: Evidence[];
  strength: EvidenceStrength;
  rulesVersion: number;
  /** Named when the category is UNKNOWN because history is unavailable (§26). */
  missingEvidence?: string[];
}

export interface Environment {
  id: EnvironmentId;
  os: string | null;
  arch: string | null;
  ciProvider: string | null;
  browser: string | null;
  nodeVersion: string | null;
  imageDigest: string | null;
}

export interface Component {
  id: ComponentId;
  name: string;
  pathGlobs: string[];
  owners: string[];
  criticality: number;
}

export interface SignalContribution {
  signal: string;
  raw: number;
  normalized: number;
  weight: number;
  contribution: number;
}

export interface RiskAssessment {
  commitSha: Sha;
  componentId: ComponentId;
  score: number;
  contributions: SignalContribution[];
  modelVersion: number;
  calibrated: boolean;
}

export interface QualityScore {
  runId: RunId;
  dimensions: Record<string, number>;
  /** Dimensions excluded for lack of data. Never silently averaged away (§14). */
  excludedDimensions: string[];
  total: number;
  modelVersion: number;
}

export interface Analysis {
  id: AnalysisId;
  runId: RunId;
  engineVersion: string;
  createdAt: string;
  outputs: Record<string, unknown>;
}

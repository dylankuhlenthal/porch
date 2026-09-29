/**
 * The shapes Porch writes and prints. Every one carries `schema: 1`; a breaking
 * change to any of them bumps SCHEMA_VERSION. The matching JSON Schema files are
 * in schemas/ and tests/schemas.test.ts checks real output against them.
 */

export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * What Porch observed about a session.
 * - starting: the session exists but has not finished starting up
 * - busy: a turn is running
 * - idle: no turn is running; a delivered message starts one
 * - waiting-on-prompt: held mid-turn by something only a person can answer
 * - gone: the session is not running any more (or its record was left behind)
 * - unknown: Porch cannot tell. Never a guess dressed up as an answer.
 */
export const SESSION_STATUSES = ["starting", "busy", "idle", "waiting-on-prompt", "gone", "unknown"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** What a session says about itself with `porch status set`. */
export const SELF_STATUSES = ["working", "needs-input", "blocked", "done", "failed"] as const;
export type SelfStatus = (typeof SELF_STATUSES)[number];

export interface SelfReport {
  status: SelfStatus;
  text: string | null;
  /** ISO 8601 time the session set this. */
  since: string;
}

/** `porch observe` output, one element of `porch list`, and one line of `porch watch`. */
export interface Observation {
  schema: SchemaVersion;
  harness: string;
  session: string;
  status: SessionStatus;
  /** ISO 8601 time the session entered `status`, or null when Porch cannot tell. */
  since: string | null;
  /** Adapter-specific, documented per adapter. Keep it small and stable: watch compares it. */
  detail: Record<string, unknown> | null;
  /** What the harness returned, as it returned it, for debugging. Watch ignores it when comparing. */
  raw: Record<string, unknown> | null;
  /** Self-reported state, side by side with `status` and never combined with it. */
  self: SelfReport | null;
}

export const DELIVER_RESULTS = ["delivered", "not-running", "failed"] as const;
export type DeliverResultKind = (typeof DELIVER_RESULTS)[number];

/** `porch deliver` output. Only says what Porch can know: see decision 0001 and the adapter contract. */
export interface DeliverResult {
  schema: SchemaVersion;
  /** Null when no adapter knows the session. */
  harness: string | null;
  session: string;
  result: DeliverResultKind;
  /** The session's status when the message was sent, or null when it was not sent. */
  statusAtSend: SessionStatus | null;
  /** How it was sent (adapter-specific, for example "socket"), or null when it was not sent. */
  via: string | null;
  /** True when the delivery address was worked out rather than recorded by the session. */
  guessed: boolean;
  /** Why it was not delivered; null when delivered. */
  reason: string | null;
}

export interface CurrentResult {
  schema: SchemaVersion;
  harness: string | null;
  session: string | null;
}

export interface ListResult {
  schema: SchemaVersion;
  sessions: Observation[];
  /** One entry per adapter whose listing failed; its sessions are missing from `sessions`. */
  errors: { harness: string; message: string }[];
}

export interface StatusSetResult {
  schema: SchemaVersion;
  harness: string;
  session: string;
  self: SelfReport;
}

/** Error codes Porch prints as JSON. Each maps to one exit code (see src/cli/exit-codes.ts). */
export const ERROR_CODES = [
  "usage",
  "not-found",
  "not-in-session",
  "ambiguous-session",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorResult {
  schema: SchemaVersion;
  error: { code: ErrorCode; message: string };
}

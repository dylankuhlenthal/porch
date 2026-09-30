/**
 * The adapter contract: what every harness adapter implements. The core (src/porch.ts,
 * src/watch.ts, src/cli/) talks to harnesses only through this. The endorsed way to
 * write an adapter is docs/patterns/adapter-contract.md.
 */
import type { Env } from "./home.js";
import type { HarnessIO } from "./io.js";
import type { RecordStore } from "./records.js";
import {
  SCHEMA_VERSION,
  type DeliverResult,
  type DeliverResultKind,
  type Observation,
  type SelfReport,
  type SessionStatus,
} from "./types.js";

/** Everything an adapter may use. Adapters read env, files and commands only through this. */
export interface AdapterContext {
  env: Env;
  /** Porch's own folder ($PORCH_HOME or ~/.porch). */
  home: string;
  /** The session records folder, for reading records and (from the inside part) writing them. */
  records: RecordStore;
  /** Outside reads from the harness. Always use this, so conformance runs can record and replay them. */
  io: HarnessIO;
  now(): Date;
}

export interface Capabilities {
  /** A message delivered while busy waits for the session's next step instead of failing. */
  queuesWhileBusy: boolean;
  /** The adapter can report `waiting-on-prompt`. */
  seesPrompts: boolean;
  /** The harness has an outside listing that confirms which sessions are alive. */
  outsideListing: boolean;
  /** The adapter has an inside part that writes session records. */
  insidePart: boolean;
  /**
   * How often `watch` polls `list()` for what only the outside can see (a session
   * dying without its end hook, a prompt opening). Null: record changes are enough.
   */
  pollIntervalMs: number | null;
}

export interface DetectResult {
  /** The harness is installed and usable on this machine. */
  available: boolean;
  version: string | null;
  /** Why it is not available; null when it is. */
  reason: string | null;
}

/** The inside part: what runs in the session and writes its record. */
export interface InsidePartInfo {
  /** For example "hooks" (Claude Code) or "extension" (Pi). */
  kind: string;
  description: string;
  /** The command a person runs to set it up, for example "porch hooks claude". */
  setup: string;
}

/** What a CLI command added by an adapter gets. */
export interface CommandContext {
  adapter: AdapterContext;
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of stdin as text (hook commands get their event JSON this way). */
  readStdin(): Promise<string>;
}

/**
 * A CLI subcommand an adapter adds, for example `porch hooks claude` (path
 * ["hooks", "claude"]) or `porch fake start`. `run` returns the exit code and
 * should print JSON on stdout like every other Porch command.
 */
export interface AdapterCommand {
  path: string[];
  summary: string;
  usage: string;
  run(args: string[], ctx: CommandContext): Promise<number>;
}

export interface Adapter {
  /** Lowercase letters and digits, for example "claude". Used in record file names. */
  readonly harness: string;
  readonly capabilities: Capabilities;
  readonly inside: InsidePartInfo | null;

  /** Is the harness installed here? May be slow (runs the harness); `list` must not depend on it. */
  detect(ctx: AdapterContext): Promise<DetectResult>;

  /** Every session this adapter can see. Must be fast: consumers call `porch list` every few seconds. */
  list(ctx: AdapterContext): Promise<Observation[]>;

  /** One session, or null when this adapter does not know it. */
  observe(ctx: AdapterContext, session: string): Promise<Observation | null>;

  /** The session this process runs inside, worked out from the environment, or null. */
  current(ctx: AdapterContext): Promise<string | null>;

  /**
   * Send `text` (already prefixed with the sender label) to the session. Report only
   * what can be known: `delivered` with the status at the moment of sending,
   * `not-running`, or `failed` with a reason. Never claim the message was read.
   */
  deliver(ctx: AdapterContext, session: string, text: string): Promise<DeliverResult>;

  /**
   * Which of `observations` (this adapter's own `list` result) is the session `id`
   * names, for ids other than the full session id that `observe` also accepts (a
   * Claude short id). Returns that session's full id, or null. `watch --session`
   * uses it, so looking up an id costs no second listing. Adapters whose `observe`
   * takes only the full id leave it out.
   */
  sessionIdIn?(id: string, observations: Observation[]): string | null;

  /** Extra files or folders `watch` should react to besides the records folder. */
  watchPaths?(ctx: AdapterContext): string[];

  /** CLI subcommands this adapter adds. */
  readonly commands?: AdapterCommand[];
}

/** Build an Observation with `schema` filled in and every optional field defaulted to null. */
export function observation(fields: {
  harness: string;
  session: string;
  status: SessionStatus;
  since?: string | null;
  detail?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
  self?: SelfReport | null;
}): Observation {
  return {
    schema: SCHEMA_VERSION,
    harness: fields.harness,
    session: fields.session,
    status: fields.status,
    since: fields.since ?? null,
    detail: fields.detail ?? null,
    raw: fields.raw ?? null,
    self: fields.self ?? null,
  };
}

/** Build a DeliverResult with `schema` filled in. */
export function deliverResult(fields: {
  harness: string | null;
  session: string;
  result: DeliverResultKind;
  statusAtSend?: SessionStatus | null;
  via?: string | null;
  guessed?: boolean;
  reason?: string | null;
}): DeliverResult {
  return {
    schema: SCHEMA_VERSION,
    harness: fields.harness,
    session: fields.session,
    result: fields.result,
    statusAtSend: fields.statusAtSend ?? null,
    via: fields.via ?? null,
    guessed: fields.guessed ?? false,
    reason: fields.reason ?? null,
  };
}

export type { Env };

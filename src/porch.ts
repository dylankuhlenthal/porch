/**
 * The library: one object that asks every adapter and combines the answers. The
 * CLI (src/cli/) is a thin layer over this, and Node consumers can use it directly.
 */
import path from "node:path";

import { deliverResult, type Adapter, type AdapterContext } from "./adapter.js";
import { builtinAdapters } from "./adapters/index.js";
import { PorchError } from "./errors.js";
import { errorMessage } from "./fsutil.js";
import { porchHome, sessionsDir, type Env } from "./home.js";
import { realIO, type HarnessIO } from "./io.js";
import { runLaunchPlan, type LaunchOutcome } from "./launch.js";
import { pruneStopped } from "./prune.js";
import { InvalidIdError, RecordStore } from "./records.js";
import {
  SCHEMA_VERSION,
  SELF_STATUSES,
  shownByDefault,
  type CurrentResult,
  type DeliverResult,
  type LaunchPlanResult,
  type ListResult,
  type Observation,
  type SelfStatus,
  type StatusSetResult,
} from "./types.js";
import { watchSessions, type WatchOptions } from "./watch.js";

export interface PorchOptions {
  /** Environment to read (PORCH_HOME, session id variables). Defaults to process.env. */
  env?: Env;
  /** Adapters to use. Defaults to the built-in ones. */
  adapters?: Adapter[];
  io?: HarnessIO;
  now?: () => Date;
}

/** The longest sender label `deliver` accepts. */
export const MAX_FROM_LENGTH = 100;

/** The text a session receives: the sender label in brackets, then the message. */
export function formatMessage(from: string, text: string): string {
  return `[from ${from}] ${text}`;
}

/** No adapter found the session, but at least one could not be asked. */
class LookupFailedError extends PorchError {
  constructor(message: string) {
    super("internal", message);
  }
}

export class Porch {
  readonly ctx: AdapterContext;
  readonly adapters: Adapter[];

  constructor(options: PorchOptions = {}) {
    const env = options.env ?? process.env;
    const now = options.now ?? (() => new Date());
    this.ctx = {
      env,
      home: porchHome(env),
      records: new RecordStore(sessionsDir(env), { now }),
      io: options.io ?? realIO,
      now,
    };
    this.adapters = options.adapters ?? builtinAdapters();
  }

  /** The adapters for one harness, or all of them. Throws a usage error for an unknown harness. */
  adaptersFor(harness?: string): Adapter[] {
    if (harness === undefined) return this.adapters;
    const found = this.adapters.filter((a) => a.harness === harness);
    if (found.length === 0) {
      throw new PorchError("usage", `unknown harness '${harness}' (known: ${this.adapters.map((a) => a.harness).join(", ")})`);
    }
    return found;
  }

  /**
   * The running sessions Porch is attached to (`attached: true`, not `ended` or
   * `gone`), or with `all` every session every adapter can see: unattached, ended and
   * gone ones included. An adapter that fails is reported in `errors`, not thrown.
   * Reading the records also prunes them: ended and gone sessions' records are removed
   * 24 hours after they stopped (src/prune.ts).
   */
  async list(harness?: string, options: { all?: boolean } = {}): Promise<ListResult> {
    const adapters = this.adaptersFor(harness);
    const results = await Promise.allSettled(adapters.map((a) => a.list(this.ctx)));
    const sessions: Observation[] = [];
    const errors: ListResult["errors"] = [];
    const seen: Observation[] = [];
    results.forEach((r, i) => {
      const adapter = adapters[i]!;
      if (r.status === "fulfilled") {
        seen.push(...r.value);
        sessions.push(...(options.all ? r.value : r.value.filter(shownByDefault)));
      } else errors.push({ harness: adapter.harness, message: errorMessage(r.reason) });
    });
    await pruneStopped(this.ctx.records, seen, this.ctx.now());
    // A record file that cannot be read would otherwise just vanish from the
    // adapter's view (its session showing as if it had no inside part). Say so.
    const wanted = new Set(adapters.map((a) => a.harness));
    const { problems } = await this.ctx.records.list().catch((err: unknown) => ({
      problems: [{ file: this.ctx.records.dir, message: errorMessage(err) }],
    }));
    for (const p of problems) {
      if (p.file === this.ctx.records.dir) {
        errors.push({ harness: "porch", message: `cannot read the records folder: ${p.message}` });
        continue;
      }
      const harness = path.basename(p.file).split("-")[0] ?? "";
      if (wanted.has(harness)) {
        errors.push({ harness, message: `unreadable session record ${path.basename(p.file)}: ${p.message}` });
      }
    }
    return { schema: SCHEMA_VERSION, sessions, errors };
  }

  /** One session. Throws not-found when no adapter knows it, ambiguous-session when more than one does. */
  async observe(session: string, harness?: string): Promise<Observation> {
    const found = await this.find(session, harness);
    return found.observation;
  }

  /**
   * Send a message to a session, prefixed with the sender label. A session no
   * adapter knows is reported as not-running rather than thrown, because from the
   * caller's side that is what it is.
   */
  async deliver(session: string, text: string, options: { from: string; harness?: string }): Promise<DeliverResult> {
    const from = options.from.trim();
    if (from === "" || from.length > MAX_FROM_LENGTH || /[\r\n\]]/.test(from)) {
      throw new PorchError("usage", `--from must be 1 to ${MAX_FROM_LENGTH} characters on one line, without ']'`);
    }
    if (text.trim() === "") throw new PorchError("usage", "the message is empty");
    let adapter: Adapter;
    try {
      adapter = (await this.find(session, options.harness)).adapter;
    } catch (err) {
      if (err instanceof PorchError && err.code === "not-found") {
        return deliverResult({
          harness: options.harness ?? null,
          session,
          result: "not-running",
          reason: "no adapter knows this session",
        });
      }
      if (err instanceof LookupFailedError) {
        // A harness we could not ask might know the session, so "not running" would be a guess.
        return deliverResult({ harness: options.harness ?? null, session, result: "failed", reason: err.message });
      }
      throw err;
    }
    try {
      return await adapter.deliver(this.ctx, session, formatMessage(from, text));
    } catch (err) {
      return deliverResult({ harness: adapter.harness, session, result: "failed", reason: errorMessage(err) });
    }
  }

  /** The session this process runs inside, asking every adapter. Null fields when outside any session. */
  async current(): Promise<CurrentResult> {
    const claims: { harness: string; session: string }[] = [];
    for (const adapter of this.adapters) {
      const session = await adapter.current(this.ctx);
      if (session !== null) claims.push({ harness: adapter.harness, session });
    }
    if (claims.length > 1) {
      throw new PorchError(
        "ambiguous-session",
        `this process looks like it runs in more than one session: ${claims.map((c) => `${c.harness} ${c.session}`).join(", ")}`,
      );
    }
    const claim = claims[0];
    return { schema: SCHEMA_VERSION, harness: claim?.harness ?? null, session: claim?.session ?? null };
  }

  /** Write the calling session's self-reported state into its record. */
  async statusSet(status: string, text: string | null): Promise<StatusSetResult> {
    if (!(SELF_STATUSES as readonly string[]).includes(status)) {
      throw new PorchError("usage", `status must be one of ${SELF_STATUSES.join(", ")}`);
    }
    const current = await this.current();
    if (current.harness === null || current.session === null) {
      throw new PorchError("not-in-session", "porch status set must run inside a session Porch can identify");
    }
    const self = { status: status as SelfStatus, text: text === null || text === "" ? null : text, since: this.ctx.now().toISOString() };
    try {
      await this.ctx.records.setSelf(current.harness, current.session, self);
    } catch (err) {
      if (err instanceof InvalidIdError) throw new PorchError("usage", err.message);
      throw err;
    }
    return { schema: SCHEMA_VERSION, harness: current.harness, session: current.session, self };
  }

  /**
   * How `porch launch` would start the harness with Porch's inside part attached,
   * given the arguments the caller wrote after the harness name. Starts nothing. The
   * records folder baked into the inside part is this Porch's `PORCH_HOME` when its
   * environment sets one. Throws a usage error for an unknown harness, a harness
   * whose adapter cannot launch, or arguments the adapter refuses.
   */
  async launchPlan(harness: string, args: string[], options: { warn?(message: string): void } = {}): Promise<LaunchPlanResult> {
    const adapter = this.adaptersFor(harness)[0]!;
    if (typeof adapter.launch !== "function") {
      throw new PorchError("usage", `the ${adapter.harness} adapter cannot launch sessions`);
    }
    const fromEnv = this.ctx.env.PORCH_HOME;
    const plan = await adapter.launch(this.ctx, args, {
      porchHome: fromEnv && fromEnv.trim() !== "" ? path.resolve(fromEnv) : null,
      warn: options.warn ?? (() => undefined),
    });
    return { schema: SCHEMA_VERSION, harness: adapter.harness, command: plan.command, args: plan.args };
  }

  /**
   * Start the harness with Porch's inside part attached, sharing this process's
   * terminal, and resolve with how it ended (src/launch.ts). Warnings go to
   * `options.warn`.
   */
  async launch(harness: string, args: string[], options: { warn?(message: string): void } = {}): Promise<LaunchOutcome> {
    const plan = await this.launchPlan(harness, args, options);
    return runLaunchPlan(plan, this.ctx.env);
  }

  /** Stay running and call `onObservation` once per change. Resolves when `signal` aborts. */
  watch(options: Omit<WatchOptions, "adapters" | "ctx">): Promise<void> {
    return watchSessions({ ...options, adapters: this.adaptersFor(options.harness), ctx: this.ctx });
  }

  private async find(session: string, harness?: string): Promise<{ adapter: Adapter; observation: Observation }> {
    const adapters = this.adaptersFor(harness);
    const settled = await Promise.allSettled(adapters.map((adapter) => adapter.observe(this.ctx, session)));
    const found: { adapter: Adapter; observation: Observation }[] = [];
    const failed: string[] = [];
    settled.forEach((r, i) => {
      const adapter = adapters[i]!;
      if (r.status === "rejected") failed.push(`${adapter.harness}: ${errorMessage(r.reason)}`);
      else if (r.value !== null) found.push({ adapter, observation: r.value });
    });
    // One harness failing must not hide a session another harness knows.
    if (found.length === 0 && failed.length > 0) {
      throw new LookupFailedError(`could not ask every harness about '${session}' (${failed.join("; ")})`);
    }
    if (found.length === 0) throw new PorchError("not-found", `no session '${session}'`);
    if (found.length > 1) {
      throw new PorchError(
        "ambiguous-session",
        `more than one harness has a session '${session}' (${found.map((f) => f.adapter.harness).join(", ")}); pass --harness`,
      );
    }
    return found[0]!;
  }
}

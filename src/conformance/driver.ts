/**
 * The harness driver: what each adapter supplies so the conformance suite can put
 * real sessions of its harness into each state. The suite (cases.ts) is written
 * against the adapter contract plus this interface only, so every adapter is held
 * to the same cases. How to write one: docs/patterns/conformance.md.
 */
import type { Adapter, AdapterContext } from "../adapter.js";
import type { Env } from "../home.js";

export interface DriverContext {
  /**
   * The environment for this case: a scratch PORCH_HOME plus PATH and HOME. Sessions
   * the driver starts must get it, so their inside part writes records into the
   * scratch folder and never into the real ~/.porch.
   */
  env: Env;
  /** A scratch folder the driver may use for session working directories and logs. */
  workDir: string;
  adapter: Adapter;
  /** The adapter context the suite uses (its io records what the harness returns). */
  adapterContext: AdapterContext;
}

/** How a `porch launch` process ended: its exit code, or the signal that killed it. */
export interface LaunchEnd {
  code: number | null;
  signal: string | null;
}

/** A session the driver started. `id` is the harness's own session id, as Porch reports it. */
export interface DriverSession {
  id: string;
  [key: string]: unknown;
}

export interface HarnessDriver {
  readonly harness: string;
  /** Which optional cases this harness can take part in. Unsupported cases are reported as skipped. */
  readonly supports: {
    /** The driver can make a session stop at a permission prompt or dialog. */
    holdAtPrompt: boolean;
    /** The driver can start a session without the adapter's inside part. */
    withoutInside: boolean;
    /**
     * The harness stops a session by itself once it has been idle long enough, and
     * the adapter reports that as `ended` with `endReasons.idleStop` (Claude Code's
     * idle stop, decision 0014). Its case is slow, so it runs only when asked for.
     */
    idleStop: boolean;
  };
  /**
   * The `endReason` the harness gives, and the adapter reports, when a session ends
   * the way `stop` ends it and the way `exitInteractive` ends it (null: the harness
   * gives no reason), and when the harness stops an idle session by itself (null when
   * it does not, `supports.idleStop` false). The `ended-cleanly`, `launch-interactive`
   * and `idle-stopped` cases check them.
   */
  readonly endReasons: { stop: string | null; exitInteractive: string | null; idleStop: string | null };
  readonly timeouts: {
    /** How long a state change (start, busy, idle, gone) may take to show. */
    changeMs: number;
    /** How long a delivered message may take to reach the session. */
    deliveryMs: number;
    /** Hard limit for one case, including setup and cleanup. */
    caseMs: number;
    /**
     * How long the harness may take to stop an idle session by itself, counted from
     * the end of its turn (needed when `supports.idleStop`). A slow case's limit is
     * `caseMs` plus this.
     */
    idleStopMs?: number;
  };

  /** The harness version under test, for the report and fixtures. */
  version(): Promise<string | null>;
  /** Called before each case with that case's scratch context. */
  setup(ctx: DriverContext): Promise<void>;
  /** Start a session with the inside part installed; resolve once it has started. */
  start(): Promise<DriverSession>;
  /** Start a session without the inside part (for example without Porch's hooks). */
  startWithoutInside(): Promise<DriverSession>;
  /** Start a turn that keeps the session busy until `makeIdle` (or for at least `changeMs`). */
  makeBusy(session: DriverSession): Promise<void>;
  /** End the busy turn (let it finish or interrupt it). */
  makeIdle(session: DriverSession): Promise<void>;
  /** Make the session stop mid-turn at a permission prompt or dialog. */
  holdAtPrompt(session: DriverSession): Promise<void>;
  /** Kill the session without letting its end hook or shutdown handler run. */
  kill(session: DriverSession): Promise<void>;
  /** The environment variables commands run inside the session see (for `current`). */
  envInside(session: DriverSession): Env;
  /** Every message the session has received from outside so far, as text. */
  received(session: DriverSession): Promise<string[]>;
  /** End the session cleanly, the way a tool stops a session (its end hook or shutdown handler runs). */
  stop(session: DriverSession): Promise<void>;

  // Launch cases: used only when the adapter can launch (`capabilities.launch`).

  /**
   * Start a background session the way a tool would, through `porch launch` with the
   * case's PORCH_HOME and the caller's own harness settings, which hold a marker the
   * driver can check (for Claude Code, a SessionStart hook that writes a file).
   * Resolve once the session is running.
   */
  launchBackground(): Promise<DriverSession>;
  /**
   * Whether the caller's own settings passed to `porch launch` took effect in the
   * session (the marker ran), or null when the harness takes no settings of the caller's.
   */
  callerSettingsApplied(session: DriverSession): Promise<boolean | null>;
  /**
   * Start an interactive session through `porch launch` in a terminal (a
   * pseudo-terminal for a real harness), as a person would. Resolve once the
   * harness lists it as running.
   */
  launchInteractive(): Promise<DriverSession>;
  /** Press Ctrl+C once in the interactive session's terminal. */
  interrupt(session: DriverSession): Promise<void>;
  /** Whether the `porch launch` process of an interactive session is still running. */
  launchRunning(session: DriverSession): boolean;
  /** End the interactive session the way a person would (`/exit`), and resolve with how `porch launch` ended. */
  exitInteractive(session: DriverSession): Promise<LaunchEnd>;
  /** Stop everything this driver started in the current case. Always called, even after a failure. */
  cleanup(): Promise<void>;
}

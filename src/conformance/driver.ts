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
  };
  readonly timeouts: {
    /** How long a state change (start, busy, idle, gone) may take to show. */
    changeMs: number;
    /** How long a delivered message may take to reach the session. */
    deliveryMs: number;
    /** Hard limit for one case, including setup and cleanup. */
    caseMs: number;
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
  /** End the session cleanly. */
  stop(session: DriverSession): Promise<void>;
  /** Stop everything this driver started in the current case. Always called, even after a failure. */
  cleanup(): Promise<void>;
}

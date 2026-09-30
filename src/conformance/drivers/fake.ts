/**
 * The fake adapter's harness driver. It proves the conformance runner and the
 * record-and-replay path without a real harness, and is the model for real
 * drivers (docs/patterns/conformance.md).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import type { AdapterContext } from "../../adapter.js";
import { FAKE_SESSION_ENV } from "../../adapters/fake/index.js";
import * as fake from "../../adapters/fake/ops.js";
import { porchCliPath } from "../../cli/path.js";
import type { Env } from "../../home.js";
import type { DriverContext, DriverSession, HarnessDriver, LaunchEnd } from "../driver.js";

interface Launched {
  child: ChildProcess;
  ended: Promise<LaunchEnd>;
}

export function createFakeDriver(): HarnessDriver {
  let ctx: AdapterContext | null = null;
  let env: Env | null = null;
  let started: string[] = [];
  let launched = new Map<string, Launched>();
  const need = (): AdapterContext => {
    if (!ctx) throw new Error("fake driver used before setup");
    return ctx;
  };
  const newId = () => `conf-${randomBytes(4).toString("hex")}`;

  /** `porch launch fake <id>` as its own process group, the way a shell starts a job. */
  async function launch(): Promise<DriverSession> {
    const id = newId();
    const child = spawn(process.execPath, [porchCliPath(), "launch", "fake", id], {
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: "ignore",
    });
    const ended = new Promise<LaunchEnd>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    launched.set(id, { child, ended });
    started.push(id);
    const deadline = Date.now() + 5000;
    while ((await need().records.read("fake", id).catch(() => null)) === null) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`porch launch fake ${id} ended before the session started`);
      if (Date.now() > deadline) throw new Error(`fake session ${id} did not start through porch launch`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return { id };
  }

  const launchedOf = (s: DriverSession): Launched => {
    const found = launched.get(s.id);
    if (!found) throw new Error(`session ${s.id} was not launched by this driver`);
    return found;
  };

  return {
    harness: "fake",
    supports: { holdAtPrompt: true, withoutInside: true },
    // `stop` gives no reason, so the null path is checked too; exitInteractive says quit.
    endReasons: { stop: null, exitInteractive: "quit" },
    timeouts: { changeMs: 5000, deliveryMs: 5000, caseMs: 30000 },
    async version() {
      return "fake-1";
    },
    async setup(driverCtx: DriverContext) {
      ctx = driverCtx.adapterContext;
      env = driverCtx.env;
      started = [];
      launched = new Map();
    },
    async start() {
      const id = newId();
      await fake.startSession(need(), id, { pid: process.pid });
      started.push(id);
      return { id };
    },
    async startWithoutInside() {
      const id = newId();
      await fake.startSession(need(), id, { inside: false, pid: process.pid });
      started.push(id);
      return { id };
    },
    async makeBusy(s: DriverSession) {
      await fake.setInsideStatus(need(), s.id, "busy");
    },
    async makeIdle(s: DriverSession) {
      await fake.setInsideStatus(need(), s.id, "idle");
    },
    async holdAtPrompt(s: DriverSession) {
      await fake.setInsideStatus(need(), s.id, "busy");
      await fake.setPrompt(need(), s.id, "Allow Bash: rm -rf build?");
    },
    async kill(s: DriverSession) {
      await fake.killSession(need(), s.id);
    },
    envInside(s: DriverSession) {
      return { [FAKE_SESSION_ENV]: s.id };
    },
    async received(s: DriverSession) {
      return (await fake.readDeliveries(need(), s.id)).map((d) => d.text);
    },
    async stop(s: DriverSession) {
      await fake.endSession(need(), s.id);
    },
    launchBackground: () => launch(),
    async callerSettingsApplied() {
      return null; // the fake harness takes no settings of the caller's
    },
    launchInteractive: () => launch(),
    async interrupt(s: DriverSession) {
      // The terminal sends Ctrl+C to the whole foreground group: porch launch and the harness.
      process.kill(-launchedOf(s).child.pid!, "SIGINT");
    },
    launchRunning(s: DriverSession) {
      const { child } = launchedOf(s);
      return child.exitCode === null && child.signalCode === null;
    },
    async exitInteractive(s: DriverSession) {
      await fake.endSession(need(), s.id, { exitCode: 0, reason: "quit" });
      return launchedOf(s).ended;
    },
    async cleanup() {
      if (!ctx) return;
      for (const id of started) await fake.endSession(ctx, id).catch(() => undefined);
      for (const { child, ended } of launched.values()) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await ended;
      }
      started = [];
      launched = new Map();
      ctx = null;
      env = null;
    },
  };
}

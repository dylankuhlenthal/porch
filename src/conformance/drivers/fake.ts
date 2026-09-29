/**
 * The fake adapter's harness driver. It proves the conformance runner and the
 * record-and-replay path without a real harness, and is the model for real
 * drivers (docs/patterns/conformance.md).
 */
import { randomBytes } from "node:crypto";

import type { AdapterContext } from "../../adapter.js";
import { FAKE_SESSION_ENV } from "../../adapters/fake/index.js";
import * as fake from "../../adapters/fake/ops.js";
import type { DriverContext, DriverSession, HarnessDriver } from "../driver.js";

export function createFakeDriver(): HarnessDriver {
  let ctx: AdapterContext | null = null;
  let started: string[] = [];
  const need = (): AdapterContext => {
    if (!ctx) throw new Error("fake driver used before setup");
    return ctx;
  };
  const newId = () => `conf-${randomBytes(4).toString("hex")}`;

  return {
    harness: "fake",
    supports: { holdAtPrompt: true, withoutInside: true },
    timeouts: { changeMs: 5000, deliveryMs: 5000, caseMs: 30000 },
    async version() {
      return "fake-1";
    },
    async setup(driverCtx: DriverContext) {
      ctx = driverCtx.adapterContext;
      started = [];
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
    async cleanup() {
      if (!ctx) return;
      for (const id of started) await fake.endSession(ctx, id).catch(() => undefined);
      started = [];
      ctx = null;
    },
  };
}

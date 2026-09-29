import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { observation } from "../src/adapter.js";
import { createFakeAdapter } from "../src/adapters/fake/index.js";
import * as fake from "../src/adapters/fake/ops.js";
import { Porch } from "../src/porch.js";
import type { Observation } from "../src/types.js";
import { comparisonKey } from "../src/watch.js";
import { BIN, bin, scratchEnv, schemaValidators, waitFor } from "./helpers.js";
import { stubAdapter } from "./stub-adapter.js";

const v = schemaValidators();

function startWatch(porch: Porch, options: { session?: string } = {}) {
  const seen: Observation[] = [];
  const errors: unknown[] = [];
  const controller = new AbortController();
  const done = porch.watch({
    ...options,
    signal: controller.signal,
    onObservation: (o) => seen.push(o),
    onError: (_h, e) => errors.push(e),
    backstopPollMs: 60_000,
  });
  return { seen, errors, stop: async () => (controller.abort(), done), statuses: () => seen.map((o) => `${o.session}:${o.status}`) };
}

describe("watch", () => {
  it("reports each change from the records folder as it happens, in order", async () => {
    // A long poll interval proves the file watch, not the poll, delivers the changes.
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter({ pollIntervalMs: 60_000 })] });
    const w = startWatch(porch);
    await new Promise((r) => setTimeout(r, 100));
    await fake.startSession(porch.ctx, "s1");
    await waitFor(() => w.statuses().includes("s1:idle"));
    await fake.setInsideStatus(porch.ctx, "s1", "busy");
    await waitFor(() => w.statuses().includes("s1:busy"));
    await fake.setInsideStatus(porch.ctx, "s1", "idle");
    await waitFor(() => w.statuses().filter((s) => s === "s1:idle").length === 2);
    await porch.ctx.records.setSelf("fake", "s1", { status: "done", text: null, since: new Date().toISOString() });
    await waitFor(() => w.seen.some((o) => o.self?.status === "done"));
    await fake.killSession(porch.ctx, "s1");
    await waitFor(() => w.statuses().includes("s1:gone"));
    await w.stop();
    expect(w.statuses()).toEqual(["s1:idle", "s1:busy", "s1:idle", "s1:idle", "s1:gone"]);
    w.seen.forEach((o) => v.observation!(o));
  });

  it("reports what only the outside listing shows (a prompt opening) through its poll", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter({ pollIntervalMs: 50 })] });
    await fake.startSession(porch.ctx, "s1", { status: "busy" });
    const w = startWatch(porch);
    await waitFor(() => w.statuses().includes("s1:busy"));
    await fake.setPrompt(porch.ctx, "s1", "Allow?");
    await waitFor(() => w.statuses().includes("s1:waiting-on-prompt"));
    await w.stop();
  });

  it("reports a session that disappears from its adapter's listing once, as gone", async () => {
    let sessions = [observation({ harness: "aa", session: "x", status: "busy" })];
    const adapter = stubAdapter("aa", { list: async () => sessions, capabilities: { ...stubAdapter("aa").capabilities, pollIntervalMs: 20 } });
    const porch = new Porch({ env: scratchEnv(), adapters: [adapter] });
    const w = startWatch(porch);
    await waitFor(() => w.statuses().includes("x:busy"));
    sessions = [];
    await waitFor(() => w.statuses().includes("x:gone"));
    await new Promise((r) => setTimeout(r, 100));
    await w.stop();
    expect(w.statuses()).toEqual(["x:busy", "x:gone"]);
  });

  it("does not report sessions as gone when their adapter's listing fails, and reports the error", async () => {
    let fail = false;
    const adapter = stubAdapter("aa", {
      list: async () => (fail ? Promise.reject(new Error("listing broke")) : [observation({ harness: "aa", session: "x", status: "idle" })]),
      capabilities: { ...stubAdapter("aa").capabilities, pollIntervalMs: 20 },
    });
    const w = startWatch(new Porch({ env: scratchEnv(), adapters: [adapter] }));
    await waitFor(() => w.statuses().includes("x:idle"));
    fail = true;
    await waitFor(() => w.errors.length > 0);
    await w.stop();
    expect(w.statuses()).toEqual(["x:idle"]);
  });

  it("ignores changes only in raw", async () => {
    let n = 0;
    const adapter = stubAdapter("aa", {
      list: async () => [observation({ harness: "aa", session: "x", status: "idle", raw: { n: n++ } })],
      capabilities: { ...stubAdapter("aa").capabilities, pollIntervalMs: 20 },
    });
    const w = startWatch(new Porch({ env: scratchEnv(), adapters: [adapter] }));
    await waitFor(() => n > 5);
    await w.stop();
    expect(w.statuses()).toEqual(["x:idle"]);
    expect(comparisonKey(observation({ harness: "a", session: "b", status: "idle", detail: { y: 1, x: 2 } }))).toBe(
      comparisonKey(observation({ harness: "a", session: "b", status: "idle", detail: { x: 2, y: 1 } })),
    );
  });

  it("watches one session only with --session", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter({ pollIntervalMs: 60_000 })] });
    const w = startWatch(porch, { session: "b" });
    await new Promise((r) => setTimeout(r, 100));
    await fake.startSession(porch.ctx, "a");
    await fake.startSession(porch.ctx, "b");
    await waitFor(() => w.statuses().includes("b:idle"));
    await w.stop();
    expect(w.seen.every((o) => o.session === "b")).toBe(true);
  });

  it("resolves promptly once stopped, and emits nothing after", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter({ pollIntervalMs: 60_000 })] });
    const w = startWatch(porch);
    await w.stop();
    const before = w.seen.length;
    await fake.startSession(porch.ctx, "late");
    await new Promise((r) => setTimeout(r, 100));
    expect(w.seen.length).toBe(before);
  });

  it("runs as `porch watch`, printing one JSON line per change until SIGTERM", async () => {
    const env = scratchEnv();
    const child = spawn(process.execPath, [BIN, "watch"], { env: env as NodeJS.ProcessEnv });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const lines = () => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Observation);
    await new Promise((r) => setTimeout(r, 300));
    await bin(["fake", "start", "w1"], env);
    await waitFor(() => lines().some((o) => o.status === "idle"));
    await bin(["fake", "set", "w1", "busy"], env);
    await waitFor(() => lines().some((o) => o.status === "busy"));
    await bin(["fake", "end", "w1"], env);
    await waitFor(() => lines().some((o) => o.status === "gone"));
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(lines().map((o) => o.status)).toEqual(["idle", "busy", "gone"]);
    lines().forEach((o) => v.observation!(o));
  });
});

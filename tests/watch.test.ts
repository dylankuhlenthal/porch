import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { observation } from "../src/adapter.js";
import { createFakeAdapter } from "../src/adapters/fake/index.js";
import * as fake from "../src/adapters/fake/ops.js";
import { Porch } from "../src/porch.js";
import type { Observation } from "../src/types.js";
import { comparisonKey, recordsEventTriggersLook } from "../src/watch.js";
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
    // It is forgotten once reported, so coming back is reported as new.
    sessions = [observation({ harness: "aa", session: "x", status: "idle" })];
    await waitFor(() => w.statuses().includes("x:idle"));
    await w.stop();
    expect(w.statuses()).toEqual(["x:busy", "x:gone", "x:idle"]);
    const gone = w.seen.find((o) => o.status === "gone")!;
    expect(gone).toMatchObject({ since: null, detail: null, raw: null });
    v.observation!(gone);
  });

  it("does not print a second gone when a session already reported gone leaves the listing", async () => {
    // For example a crashed session (gone, record left behind) whose record is later cleaned up.
    let sessions = [observation({ harness: "aa", session: "x", status: "gone", since: "2026-01-01T00:00:00.000Z" })];
    let looks = 0;
    const adapter = stubAdapter("aa", {
      list: async () => (looks++, sessions),
      capabilities: { ...stubAdapter("aa").capabilities, pollIntervalMs: 20 },
    });
    const w = startWatch(new Porch({ env: scratchEnv(), adapters: [adapter] }));
    await waitFor(() => w.statuses().includes("x:gone"));
    sessions = [];
    const after = looks;
    await waitFor(() => looks > after + 3);
    await w.stop();
    expect(w.statuses()).toEqual(["x:gone"]);
    expect(w.seen[0]!.since).toBe("2026-01-01T00:00:00.000Z");
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

  it("with --session, follows a session given by another id its adapter accepts (a Claude short id), found in the listing", async () => {
    const full = "5b0e750e-44ca-46ad-a46a-6408e83922b1";
    let status: Observation["status"] = "idle";
    let observed = 0;
    const adapter = stubAdapter("aa", {
      list: async () => [observation({ harness: "aa", session: full, status }), observation({ harness: "aa", session: "other", status: "busy" })],
      sessionIdIn: (id, obs) => (id === "5b0e750e" ? (obs.find((o) => o.session === full)?.session ?? null) : null),
      observe: async () => (observed++, null),
      capabilities: { ...stubAdapter("aa").capabilities, pollIntervalMs: 20 },
    });
    const w = startWatch(new Porch({ env: scratchEnv(), adapters: [adapter] }), { session: "5b0e750e" });
    await waitFor(() => w.statuses().includes(`${full}:idle`));
    status = "busy";
    await waitFor(() => w.statuses().includes(`${full}:busy`));
    await w.stop();
    expect(w.statuses()).toEqual([`${full}:idle`, `${full}:busy`]);
    expect(observed).toBe(0);
  });

  it("with --session not found yet, makes no call beyond the listing, and reports a lookup error", async () => {
    let looks = 0;
    let observed = 0;
    const adapter = stubAdapter("aa", {
      list: async () => (looks++, [observation({ harness: "aa", session: "other", status: "busy" })]),
      sessionIdIn: () => {
        throw new Error("lookup broke");
      },
      observe: async () => (observed++, null),
      capabilities: { ...stubAdapter("aa").capabilities, pollIntervalMs: 20 },
    });
    const w = startWatch(new Porch({ env: scratchEnv(), adapters: [adapter] }), { session: "nobody" });
    await waitFor(() => looks > 3);
    await w.stop();
    expect(observed).toBe(0);
    expect(w.seen).toEqual([]);
    expect(w.errors.length).toBeGreaterThan(0);
    expect(String(w.errors[0])).toMatch(/lookup broke/);
  });

  it("does not look again for lock and temp files in the records folder, only for records", async () => {
    let looks = 0;
    const adapter = stubAdapter("aa", { list: async () => (looks++, []) });
    const porch = new Porch({ env: scratchEnv(), adapters: [adapter] });
    const w = startWatch(porch);
    await waitFor(() => looks >= 1);
    // Creating the records folder can itself send one event just after the watch starts (seen on macOS).
    await new Promise((r) => setTimeout(r, 200));
    const before = looks;
    const dir = porch.ctx.records.dir;
    for (const name of ["aa-x.json.lock", "aa-x.json.123.abcd1234.tmp", "aa-x.json.lock.breaking.0a1b2c3d"]) {
      await fs.writeFile(path.join(dir, name), "x");
      await fs.unlink(path.join(dir, name));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(looks).toBe(before);
    await fs.writeFile(path.join(dir, "aa-x.json"), "{}");
    await waitFor(() => looks === before + 1);
    await w.stop();
    expect(recordsEventTriggersLook(null)).toBe(true);
    expect(recordsEventTriggersLook("claude-abc.json")).toBe(true);
    expect(recordsEventTriggersLook("claude-abc.json.lock")).toBe(false);
    expect(recordsEventTriggersLook("claude-abc.json.99.deadbeef.tmp")).toBe(false);
    expect(recordsEventTriggersLook("claude-abc.json.lock.breaking.deadbeef")).toBe(false);
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

  it("exits 0 when the reader closes its stdout", async () => {
    const env = scratchEnv();
    await bin(["fake", "start", "p1"], env);
    const child = spawn(process.execPath, [BIN, "watch"], { env: env as NodeJS.ProcessEnv });
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.stdout.destroy();
    await bin(["fake", "set", "p1", "busy"], env);
    expect(await exit).toBe(0);
  });
});

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Adapter, AdapterContext } from "../src/adapter.js";
import { deliverResult } from "../src/adapter.js";
import { createFakeAdapter } from "../src/adapters/fake/index.js";
import { fakeStatePath, updateState } from "../src/adapters/fake/state.js";
import { CASES } from "../src/conformance/cases.js";
import { CONFORMANCE_EXIT, conformanceCommand } from "../src/conformance/command.js";
import type { HarnessDriver } from "../src/conformance/driver.js";
import { createFakeDriver } from "../src/conformance/drivers/fake.js";
import { DRIVERS } from "../src/conformance/drivers/index.js";
import { FIXTURES_DIR, reportPath } from "../src/conformance/paths.js";
import { newFixture, RecordingIO, replayFixture, takeSnapshot, type Fixture } from "../src/conformance/recorder.js";
import { runConformance } from "../src/conformance/runner.js";
import { porchHome, sessionsDir } from "../src/home.js";
import { realIO } from "../src/io.js";
import { RecordStore, type SessionRecord } from "../src/records.js";
import { REPO, scratchEnv, schemaValidators } from "./helpers.js";

const v = schemaValidators();

/** Laid out like a conformance case: PORCH_HOME inside the case folder (the Claude adapter relies on it). */
function replayScratch() {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "porch-replay-"));
  // Replay answers every harness command from the recording, so the command name must be the recorded one.
  return { env: scratchEnv({ PORCH_HOME: path.join(workDir, "porch-home"), PORCH_CLAUDE_BIN: undefined }), workDir };
}

function quickDriver(overrides: Partial<HarnessDriver> = {}): HarnessDriver {
  const base = createFakeDriver();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    timeouts: { changeMs: 400, deliveryMs: 400, caseMs: 5000 },
    ...overrides,
  });
}

function withAdapter(overrides: Partial<Adapter>): Adapter {
  return { ...createFakeAdapter({ pollIntervalMs: 50 }), ...overrides };
}

function resultOf(report: Awaited<ReturnType<typeof runConformance>>, name: string) {
  return report.results.find((r) => r.name === name);
}

describe("conformance suite against the fake adapter", () => {
  it("passes every case, records a fixture per case, and each fixture replays cleanly", async () => {
    const fixtures: Fixture[] = [];
    const report = await runConformance({
      adapter: createFakeAdapter({ pollIntervalMs: 50 }),
      driver: createFakeDriver(),
      onFixture: (f) => {
        fixtures.push(f);
      },
    });
    v["conformance-report"]!(report);
    // The slow case runs only when asked for.
    expect(report.results.map((r) => [r.name, r.result, r.reason])).toEqual(
      CASES.map((c) => (c.slow ? [c.name, "skip", "a slow case: run with --slow, or name it with --case"] : [c.name, "pass", null])),
    );
    expect(report.passed).toBe(true);
    expect(fixtures.map((f) => f.case).sort()).toEqual(CASES.filter((c) => !c.slow && c.name !== "unknown-session").map((c) => c.name).sort());
    for (const f of fixtures) {
      v.fixture!(f);
      expect(await replayFixture(f, createFakeAdapter(), replayScratch())).toEqual([]);
    }
  });

  it("keeps the values of the harness's extra environment variables (its API key) out of fixtures", async () => {
    const secret = "sk-test-0123456789abcdef";
    const real = createFakeAdapter();
    // An adapter whose harness output happens to echo the key.
    const adapter = withAdapter({
      list: async (ctx) => (await real.list(ctx)).map((o) => ({ ...o, raw: { ...o.raw, leaked: `key=${ctx.env.PORCH_TEST_API_KEY}` } })),
    });
    const fixtures: Fixture[] = [];
    const report = await runConformance({
      adapter,
      driver: quickDriver(),
      cases: ["deliver-while-idle"],
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, PORCH_TEST_API_KEY: secret },
      onFixture: (f) => {
        fixtures.push(f);
      },
    });
    expect(report.passed).toBe(true);
    const text = JSON.stringify(fixtures);
    expect(text).not.toContain(secret);
    expect(text).toContain("key=$REDACTED");
  });

  it("covers every case named in decision 15, plus self-reported state, the launch cases and a made-up session", () => {
    expect(CASES.map((c) => c.name)).toEqual([
      "which-session-am-i",
      "deliver-while-idle",
      "deliver-while-busy",
      "held-at-prompt",
      "killed-session",
      "ended-cleanly",
      "idle-stopped",
      "without-inside-part",
      "watch-delivers-each-change",
      "self-reported-state",
      "launch-background",
      "launch-interactive",
      "unknown-session",
    ]);
  });
});

describe("conformance suite catches adapters that break the contract", () => {
  it("fails killed-session when deliver claims success for a dead session", async () => {
    const adapter = withAdapter({
      deliver: async (_c, session) => deliverResult({ harness: "fake", session, result: "delivered", statusAtSend: "idle", via: "x" }),
    });
    const report = await runConformance({ adapter, driver: quickDriver(), cases: ["killed-session", "unknown-session"] });
    expect(report.passed).toBe(false);
    expect(resultOf(report, "killed-session")?.result).toBe("fail");
    expect(resultOf(report, "unknown-session")?.result).toBe("fail");
  });

  it("fails held-at-prompt when the adapter claims to see prompts but never reports one", async () => {
    const real = createFakeAdapter();
    const adapter = withAdapter({
      observe: async (ctx, s) => {
        const o = await real.observe(ctx, s);
        return o && o.status === "waiting-on-prompt" ? { ...o, status: "busy" } : o;
      },
    });
    const report = await runConformance({ adapter, driver: quickDriver(), cases: ["held-at-prompt"] });
    expect(resultOf(report, "held-at-prompt")).toMatchObject({ result: "fail", reason: expect.stringMatching(/timed out/) });
  });

  it("fails ended-cleanly when a session that ended cleanly is reported as gone, or with another reason", async () => {
    const real = createFakeAdapter();
    const asGone = withAdapter({
      observe: async (ctx, s) => {
        const o = await real.observe(ctx, s);
        return o && o.status === "ended" ? { ...o, status: "gone", endReason: null } : o;
      },
    });
    const report = await runConformance({ adapter: asGone, driver: quickDriver(), cases: ["ended-cleanly"] });
    expect(resultOf(report, "ended-cleanly")).toMatchObject({ result: "fail", reason: expect.stringMatching(/timed out/) });
    const wrongReason = withAdapter({
      observe: async (ctx, s) => {
        const o = await real.observe(ctx, s);
        return o && o.status === "ended" ? { ...o, endReason: "made up" } : o;
      },
    });
    const report2 = await runConformance({ adapter: wrongReason, driver: quickDriver(), cases: ["ended-cleanly"] });
    expect(resultOf(report2, "ended-cleanly")).toMatchObject({ result: "fail", reason: 'the ended session\'s endReason was "made up", expected null' });
  });

  it("fails which-session-am-i when current ignores the environment", async () => {
    const adapter = withAdapter({ current: async () => "always-this" });
    const report = await runConformance({ adapter, driver: quickDriver(), cases: ["which-session-am-i"] });
    expect(resultOf(report, "which-session-am-i")?.result).toBe("fail");
  });

  it("fails watch-delivers-each-change when a change never reaches watch", async () => {
    const real = createFakeAdapter();
    const adapter = withAdapter({
      list: async (ctx) => (await real.list(ctx)).map((o) => (o.status === "busy" ? { ...o, status: "idle" } : o)),
    });
    const report = await runConformance({ adapter, driver: quickDriver(), cases: ["watch-delivers-each-change"] });
    expect(resultOf(report, "watch-delivers-each-change")?.result).toBe("fail");
  });

  it("reports a case the driver cannot take part in as skipped, without failing the run", async () => {
    const driver = quickDriver({ supports: { holdAtPrompt: false, withoutInside: false, idleStop: false } });
    const report = await runConformance({ adapter: createFakeAdapter(), driver, cases: ["held-at-prompt", "without-inside-part"] });
    expect(report.results.map((r) => r.result)).toEqual(["skip", "skip"]);
    expect(report.passed).toBe(true);
  });

  /**
   * The fake harness does not stop idle sessions; this driver makes it, by marking
   * the record ended with reason "idle" a moment after the turn ends, the way the
   * Claude adapter marks it from Claude Code's daemon log.
   */
  function idleStoppingDriver(reason: string | null = "idle"): HarnessDriver {
    const driver = quickDriver({
      supports: { holdAtPrompt: true, withoutInside: true, idleStop: true },
      endReasons: { stop: null, exitInteractive: "quit", idleStop: "idle" },
      timeouts: { changeMs: 400, deliveryMs: 400, caseMs: 5000, idleStopMs: 2000 },
    });
    const { setup, makeIdle } = driver;
    let records: RecordStore | null = null;
    driver.setup = async (ctx) => {
      records = ctx.adapterContext.records;
      await setup(ctx);
    };
    driver.makeIdle = async (s) => {
      await makeIdle(s);
      setTimeout(() => void records!.markInsideEnded("fake", s.id, { endedAt: new Date().toISOString(), endReason: reason }), 300);
    };
    return driver;
  }

  it("runs the slow idle-stopped case only when asked for, and skips it for a driver without idle stops", async () => {
    const all = await runConformance({ adapter: createFakeAdapter(), driver: idleStoppingDriver() });
    expect(resultOf(all, "idle-stopped")).toMatchObject({ result: "skip", reason: expect.stringMatching(/--slow/) });
    const fixtures: Fixture[] = [];
    const slow = await runConformance({ adapter: createFakeAdapter(), driver: idleStoppingDriver(), slow: true, onFixture: (f) => void fixtures.push(f) });
    expect(resultOf(slow, "idle-stopped")).toMatchObject({ result: "pass", reason: null });
    const named = await runConformance({ adapter: createFakeAdapter(), driver: idleStoppingDriver(), cases: ["idle-stopped"] });
    expect(named.results.map((r) => [r.name, r.result])).toEqual([["idle-stopped", "pass"]]);
    const unsupported = await runConformance({ adapter: createFakeAdapter(), driver: quickDriver(), cases: ["idle-stopped"] });
    expect(resultOf(unsupported, "idle-stopped")).toMatchObject({ result: "skip", reason: expect.stringMatching(/supports.idleStop is false/) });
    // Snapshots: idle, the first look that sees the stop (taken before the record is marked), and after.
    const fixture = fixtures.find((f) => f.case === "idle-stopped")!;
    expect(fixture.snapshots.map((s) => [s.label, s.observations[0]?.status])).toEqual([
      ["idle", "idle"],
      ["idle-stopped", "ended"],
      ["marked", "ended"],
    ]);
    expect(await replayFixture(fixture, createFakeAdapter(), replayScratch())).toEqual([]);
  });

  it("fails idle-stopped when an idle stop is reported as gone, or with another reason", async () => {
    const real = createFakeAdapter();
    const asGone = withAdapter({
      observe: async (ctx, s) => {
        const o = await real.observe(ctx, s);
        return o && o.status === "ended" ? { ...o, status: "gone", endReason: null } : o;
      },
    });
    const report = await runConformance({ adapter: asGone, driver: idleStoppingDriver(), cases: ["idle-stopped"] });
    expect(resultOf(report, "idle-stopped")).toMatchObject({ result: "fail", reason: expect.stringMatching(/showed gone once it stopped, expected ended/) });
    const other = await runConformance({ adapter: createFakeAdapter(), driver: idleStoppingDriver("other"), cases: ["idle-stopped"] });
    expect(resultOf(other, "idle-stopped")).toMatchObject({ result: "fail", reason: 'the idle-stopped session\'s endReason was "other", expected "idle"' });
  });

  it("gives a slow case the driver's idleStopMs on top of caseMs, and still fails one that never stops", async () => {
    const driver = quickDriver({
      supports: { holdAtPrompt: true, withoutInside: true, idleStop: true },
      endReasons: { stop: null, exitInteractive: "quit", idleStop: "idle" },
      timeouts: { changeMs: 400, deliveryMs: 400, caseMs: 5000, idleStopMs: 600 },
    });
    const report = await runConformance({ adapter: createFakeAdapter(), driver, cases: ["idle-stopped"] });
    expect(resultOf(report, "idle-stopped")).toMatchObject({ result: "fail", reason: expect.stringMatching(/timed out after 600 ms waiting for session .* to be stopped for being idle/) });
  });

  it("fails killed-session when reading what the harness left marks a killed session ended", async () => {
    const real = createFakeAdapter();
    const marksEverything = withAdapter({
      observe: async (ctx, s) => {
        const o = await real.observe(ctx, s);
        if (o?.status !== "gone") return o;
        await ctx.records.markInsideEnded("fake", s, { endedAt: new Date().toISOString(), endReason: "idle" });
        return o;
      },
    });
    const report = await runConformance({ adapter: marksEverything, driver: quickDriver(), cases: ["killed-session"] });
    expect(resultOf(report, "killed-session")).toMatchObject({ result: "fail" });
  });

  it("stops a case that hangs at the driver's time limit and still cleans up", async () => {
    let cleaned = false;
    const base = quickDriver();
    const driver = quickDriver({
      timeouts: { changeMs: 60_000, deliveryMs: 60_000, caseMs: 300 },
      makeBusy: () => new Promise<void>(() => undefined),
      cleanup: async () => {
        cleaned = true;
        await base.cleanup();
      },
    });
    const report = await runConformance({ adapter: createFakeAdapter(), driver, cases: ["deliver-while-busy"] });
    expect(resultOf(report, "deliver-while-busy")).toMatchObject({ result: "fail", reason: expect.stringMatching(/longer than 300 ms/) });
    expect(cleaned).toBe(true);
  });

  it("after a timeout, waits for a session the case was still starting, so cleanup stops it", async () => {
    const live = new Set<string>();
    const driver = quickDriver({
      timeouts: { changeMs: 60_000, deliveryMs: 60_000, caseMs: 200 },
      start: async () => {
        await new Promise((r) => setTimeout(r, 300));
        live.add("late");
        return { id: "late" };
      },
      cleanup: async () => live.clear(),
    });
    const report = await runConformance({ adapter: createFakeAdapter(), driver, cases: ["which-session-am-i"] });
    expect(resultOf(report, "which-session-am-i")).toMatchObject({ result: "fail", reason: expect.stringMatching(/longer than 200 ms/) });
    // Give a start the runner did not wait for time to finish, so the check below would see it.
    await new Promise((r) => setTimeout(r, 300));
    expect([...live]).toEqual([]);
  });

  it("refuses an unknown case name and a driver for another harness", async () => {
    await expect(runConformance({ adapter: createFakeAdapter(), driver: createFakeDriver(), cases: ["nope"] })).rejects.toThrow(/unknown/);
    const other = quickDriver({ harness: "other" });
    await expect(runConformance({ adapter: createFakeAdapter(), driver: other })).rejects.toThrow(/driver is for other/);
  });
});

describe("replay of committed fixtures", () => {
  const root = path.join(REPO, FIXTURES_DIR);
  const files = existsSync(root)
    ? readdirSync(root).flatMap((h) => readdirSync(path.join(root, h)).map((f) => path.join(root, h, f)))
    : [];

  it("has fixtures for every adapter with a driver", () => {
    for (const harness of Object.keys(DRIVERS)) {
      expect(files.some((f) => path.basename(path.dirname(f)) === harness), `no fixtures for ${harness}`).toBe(true);
    }
  });

  it.each(files.map((f) => [path.relative(REPO, f), f]))("%s still gives the recorded observations", async (_name, file) => {
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    v.fixture!(fixture);
    const entry = DRIVERS[fixture.harness];
    expect(entry, `no adapter registered for ${fixture.harness}`).toBeDefined();
    const mismatches = await replayFixture(fixture, entry!.adapter(), replayScratch());
    // On failure: the adapter now reads this recorded harness output differently.
    // Fix the adapter, or re-record with `npm run conformance -- --harness <h> --record`.
    expect(mismatches).toEqual([]);
  });

  it("the committed reports match the report schema and passed", () => {
    for (const harness of Object.keys(DRIVERS)) {
      const report = JSON.parse(readFileSync(reportPath(REPO, harness), "utf8"));
      v["conformance-report"]!(report);
      expect(report.passed).toBe(true);
    }
  });

  it("notices when an adapter's reading of recorded output changes", async () => {
    const file = files.find((f) => f.endsWith(path.join("fake", "deliver-while-busy.json")))!;
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    const tampered = structuredClone(fixture);
    tampered.snapshots[0]!.observations[0]!.status = "idle";
    const mismatches = await replayFixture(tampered, createFakeAdapter(), replayScratch());
    expect(mismatches.map((m) => m.snapshot)).toEqual([fixture.snapshots[0]!.label]);
  });

  it("treats an outside read that was not recorded as a mismatch", async () => {
    const file = files.find((f) => f.endsWith(path.join("fake", "deliver-while-idle.json")))!;
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    const stripped = structuredClone(fixture);
    stripped.snapshots.forEach((s) => (s.io = []));
    const mismatches = await replayFixture(stripped, createFakeAdapter(), replayScratch());
    expect(mismatches.length).toBe(fixture.snapshots.length);
    expect(mismatches[0]!.actual).toEqual({ error: expect.stringMatching(/no recorded result/) });
  });
});

describe("snapshots", () => {
  it("record the records the adapter listed from, even when a record changes mid-snapshot, so the fixture replays", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "porch-snapshot-test-"));
    const env = scratchEnv({ PORCH_HOME: path.join(workDir, "porch-home") });
    const live = new RecordStore(sessionsDir(env));
    await updateState(fakeStatePath(env), (state) => {
      state.sessions.s1 = { alive: true, pid: 4242 };
    });
    await live.updateInside("fake", "s1", { status: "idle" });
    // An adapter that names the records folder it read: the fixture must not keep the copy's temporary path.
    const namingItsRecordsDir = (): Adapter => {
      const real = createFakeAdapter();
      return withAdapter({
        list: async (ctx) => (await real.list(ctx)).map((o) => ({ ...o, raw: { ...o.raw, recordsDir: ctx.records.dir } })),
      });
    };
    const naming = namingItsRecordsDir();
    // The session's inside part writes between the recorder's copy of the records and the adapter's read.
    const adapter = withAdapter({
      list: async (ctx) => {
        await live.updateInside("fake", "s1", { status: "busy" });
        return naming.list(ctx);
      },
    });
    const io = new RecordingIO(realIO);
    const ctx: AdapterContext = { env, home: porchHome(env), records: live, io, now: () => new Date() };

    const snap = await takeSnapshot("mid-change", adapter, ctx, io, workDir);

    expect((await live.read("fake", "s1"))?.inside?.status).toBe("busy");
    expect((snap.records["fake-s1.json"] as SessionRecord).inside?.status).toBe("idle");
    expect(snap.observations.map((o) => [o.session, o.status, o.raw?.recordsDir])).toEqual([["s1", "idle", "$PORCH_HOME/sessions"]]);
    const fixture = newFixture("fake", "fake-1", "mid-change", [snap]);
    v.fixture!(fixture);
    expect(await replayFixture(fixture, namingItsRecordsDir(), replayScratch())).toEqual([]);
  });
});

describe("npm run conformance (the command)", () => {
  function run(argv: string[], drivers = DRIVERS, env: Record<string, string | undefined> = scratchEnv()) {
    let stdout = "";
    let stderr = "";
    const root = mkdtempSync(path.join(os.tmpdir(), "porch-conf-root-"));
    return conformanceCommand(argv, {
      env,
      root,
      drivers,
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
    }).then((code) => ({ code, stdout, stderr, root }));
  }

  it("runs the fake harness and, with --record, writes fixtures and the report under conformance/", async () => {
    const r = await run(["--harness", "fake", "--record", "--case", "deliver-while-idle"]);
    expect(r.code).toBe(CONFORMANCE_EXIT.passed);
    expect(JSON.parse(r.stdout).passed).toBe(true);
    expect(existsSync(path.join(r.root, "conformance", "fixtures", "fake", "deliver-while-idle.json"))).toBe(true);
    expect(existsSync(path.join(r.root, "conformance", "reports", "fake.json"))).toBe(true);
  });

  it("skips cleanly, exit 3, when a variable the harness needs (the API key) is not set", async () => {
    const drivers = { keyed: { ...DRIVERS.fake!, requiredEnv: ["PORCH_TEST_API_KEY"], needsInstalledHarness: true } };
    const r = await run(["--harness", "keyed"], drivers);
    expect(r.code).toBe(CONFORMANCE_EXIT.skipped);
    expect(JSON.parse(r.stdout)).toEqual({ schema: 2, harness: "keyed", skipped: "not set: PORCH_TEST_API_KEY" });
  });

  it("refuses to run a real harness that is not installed", async () => {
    const drivers = {
      missing: {
        adapter: () => ({ ...createFakeAdapter(), detect: async () => ({ available: false, version: null, reason: "not on PATH" }) }),
        driver: createFakeDriver,
        requiredEnv: [],
        needsInstalledHarness: true,
      },
    };
    const r = await run(["--harness", "missing"], drivers);
    expect(r.code).toBe(CONFORMANCE_EXIT.usage);
    expect(r.stderr).toContain("not on PATH");
  });

  it("skips, exit 3, when the driver says real turns cannot run here, but only once the harness is installed", async () => {
    let seen: Record<string, string | undefined> | null = null;
    const unavailableReason = async (env: Record<string, string | undefined>) => {
      seen = env;
      return "not logged in";
    };
    const keyed = {
      ...DRIVERS.fake!,
      adapter: () => ({ ...createFakeAdapter(), detect: async () => ({ available: true, version: "1", reason: null }) }),
      needsInstalledHarness: true,
      optionalEnv: ["PORCH_TEST_KEY", "PORCH_TEST_UNSET"],
      unavailableReason,
    };
    const env: Record<string, string | undefined> = { ...scratchEnv(), USER: "someone", PORCH_TEST_KEY: "k-0123456789", PORCH_TEST_OTHER: "x" };
    const r = await run(["--harness", "keyed"], { keyed }, env);
    expect(r.code).toBe(CONFORMANCE_EXIT.skipped);
    expect(JSON.parse(r.stdout)).toEqual({ schema: 2, harness: "keyed", skipped: "not logged in" });
    // Sessions start from PATH, HOME, USER and the optional variables that are set; nothing else.
    expect(seen).toEqual({ PATH: env.PATH, HOME: env.HOME, USER: "someone", PORCH_TEST_KEY: "k-0123456789" });
    const missing = {
      ...keyed,
      adapter: () => ({ ...createFakeAdapter(), detect: async () => ({ available: false, version: null, reason: "not on PATH" }) }),
    };
    expect((await run(["--harness", "missing"], { missing }, env)).code).toBe(CONFORMANCE_EXIT.usage);
  });

  it("makes case folders under the driver's workRoot and keeps optional variables out of fixtures", async () => {
    const workRoot = mkdtempSync(path.join(os.tmpdir(), "porch-workroot-"));
    const secret = "k-0123456789abcdef";
    const real = createFakeAdapter({ pollIntervalMs: 50 });
    let home: string | null = null;
    const drivers = {
      fake: {
        ...DRIVERS.fake!,
        optionalEnv: ["PORCH_TEST_KEY"],
        workRoot: () => workRoot,
        adapter: () =>
          withAdapter({
            list: async (ctx) => {
              home = ctx.home;
              return (await real.list(ctx)).map((o) => ({ ...o, raw: { ...o.raw, leaked: ctx.env.PORCH_TEST_KEY } }));
            },
          }),
      },
    };
    const r = await run(["--harness", "fake", "--record", "--case", "deliver-while-idle"], drivers, { ...scratchEnv(), PORCH_TEST_KEY: secret });
    expect(r.code).toBe(CONFORMANCE_EXIT.passed);
    expect(home!.startsWith(workRoot + path.sep)).toBe(true);
    const fixture = readFileSync(path.join(r.root, "conformance", "fixtures", "fake", "deliver-while-idle.json"), "utf8");
    expect(fixture).not.toContain(secret);
    expect(fixture).toContain("$REDACTED");
  });

  it("exits 1 when a case fails, and 2 for an unknown harness or case", async () => {
    const drivers = {
      fake: {
        ...DRIVERS.fake!,
        adapter: () => withAdapter({ current: async () => "always-this" }),
        driver: () => quickDriver(),
      },
    };
    expect((await run(["--harness", "fake", "--case", "which-session-am-i"], drivers)).code).toBe(CONFORMANCE_EXIT.failed);
    expect((await run(["--harness", "nope"])).code).toBe(CONFORMANCE_EXIT.usage);
    expect((await run(["--harness", "fake", "--case", "nope"])).code).toBe(CONFORMANCE_EXIT.usage);
  });
});

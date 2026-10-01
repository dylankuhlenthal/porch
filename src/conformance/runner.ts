/**
 * Runs the conformance cases against one adapter and its harness driver.
 *
 * Every case gets its own scratch folder with its own PORCH_HOME, so no case sees
 * another's sessions and nothing touches the real ~/.porch. The driver's cleanup
 * always runs, and each case has a hard time limit (the driver's caseMs), so a
 * hung harness cannot leave the run waiting forever. After a timeout the runner
 * waits up to caseMs more for the case to finish before cleanup, so a session the
 * case was still starting is stopped too.
 *
 * Slow cases (the harness stopping an idle session, an hour or more) run only when
 * asked for: with `slow`, or named in `cases`. Otherwise they are reported as
 * skipped. Their time limit is caseMs plus the driver's idleStopMs.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Adapter } from "../adapter.js";
import { version as porchVersion } from "../cli/run.js";
import { errorMessage } from "../fsutil.js";
import type { Env } from "../home.js";
import { realIO } from "../io.js";
import { Porch } from "../porch.js";
import { SCHEMA_VERSION, type SchemaVersion } from "../types.js";
import { CASES, ConformanceSkip, type CaseContext, type ConformanceCase } from "./cases.js";
import type { DriverSession, HarnessDriver } from "./driver.js";
import { newFixture, RecordingIO, takeSnapshot, type Fixture, type Snapshot } from "./recorder.js";

export interface CaseResult {
  name: string;
  title: string;
  result: "pass" | "fail" | "skip";
  /** Why it failed or was skipped. */
  reason: string | null;
  durationMs: number;
}

export interface ConformanceReport {
  schema: SchemaVersion;
  harness: string;
  harnessVersion: string | null;
  porchVersion: string;
  platform: string;
  ranAt: string;
  /** True when no case failed. Skipped cases are listed but do not fail the run. */
  passed: boolean;
  results: CaseResult[];
}

export interface ConformanceOptions {
  adapter: Adapter;
  driver: HarnessDriver;
  /** Run only these cases (by name). A slow case named here runs. */
  cases?: string[];
  /** Also run the slow cases when running every case. */
  slow?: boolean;
  /**
   * The environment sessions start from. Defaults to PATH, HOME and USER from this
   * process (the harness may need HOME and USER for its login); the runner adds a scratch
   * PORCH_HOME per case. Nothing else is inherited, so a session id variable from
   * the shell running the suite cannot leak into a case.
   */
  baseEnv?: Env;
  /** Called with each fixture as its case finishes (only for cases that passed). */
  onFixture?(fixture: Fixture): Promise<void> | void;
  log?(line: string): void;
  /** Sender label for deliveries. */
  from?: string;
  /** Where each case's scratch folder is made. Default: the system temp folder. */
  workRoot?: string;
  /** Applied to each snapshot before it goes into a fixture (see DriverEntry.scrubSnapshot). */
  scrubSnapshot?(snapshot: Snapshot): Snapshot;
}

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const { adapter, driver } = options;
  if (adapter.harness !== driver.harness) {
    throw new Error(`driver is for ${driver.harness} but the adapter is ${adapter.harness}`);
  }
  const selected = options.cases ? CASES.filter((c) => options.cases!.includes(c.name)) : CASES;
  if (options.cases) {
    const unknown = options.cases.filter((n) => !CASES.some((c) => c.name === n));
    if (unknown.length > 0) throw new Error(`unknown conformance case: ${unknown.join(", ")}`);
  }
  const harnessVersion = await driver.version();
  const baseEnv: Env = options.baseEnv ?? { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER };
  const results: CaseResult[] = [];
  for (const c of selected) {
    const started = Date.now();
    options.log?.(`… ${c.name}${c.slow ? " (slow)" : ""}`);
    const outcome =
      c.slow && !options.cases && !options.slow
        ? { result: "skip" as const, reason: "a slow case: run with --slow, or name it with --case" }
        : await runCase(c, options, baseEnv, harnessVersion);
    results.push({ name: c.name, title: c.title, ...outcome, durationMs: Date.now() - started });
    options.log?.(`${outcome.result === "pass" ? "✓" : outcome.result === "skip" ? "-" : "✗"} ${c.name}${outcome.reason ? `: ${outcome.reason}` : ""}`);
  }
  return {
    schema: SCHEMA_VERSION,
    harness: adapter.harness,
    harnessVersion,
    porchVersion: porchVersion(),
    platform: `${process.platform}-${process.arch} node ${process.version}`,
    ranAt: new Date().toISOString(),
    passed: results.every((r) => r.result !== "fail"),
    results,
  };
}

async function runCase(
  c: ConformanceCase,
  options: ConformanceOptions,
  baseEnv: Env,
  harnessVersion: string | null,
): Promise<{ result: CaseResult["result"]; reason: string | null }> {
  const { adapter, driver } = options;
  const root = options.workRoot ?? os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(root, `porch-conformance-${c.name}-`));
  const env: Env = { ...baseEnv, PORCH_HOME: path.join(workDir, "porch-home") };
  const io = new RecordingIO(realIO);
  // Everything in the base environment besides PATH, HOME and USER is there because the
  // harness needs it (an API key, for example): keep its values out of fixtures.
  const secrets = Object.entries(baseEnv)
    .filter(([k, v]) => k !== "PATH" && k !== "HOME" && k !== "USER" && typeof v === "string")
    .map(([, v]) => v as string);
  const porch = new Porch({ env, adapters: [adapter], io });
  const snapshots: Snapshot[] = [];
  const ctx: CaseContext = {
    adapter,
    driver,
    porch,
    porchInside: (s: DriverSession) => new Porch({ env: { ...env, ...driver.envInside(s) }, adapters: [adapter], io }),
    snapshot: async (label) => {
      const snap = await takeSnapshot(label, adapter, porch.ctx, io, workDir, secrets);
      snapshots.push(options.scrubSnapshot ? options.scrubSnapshot(snap) : snap);
    },
    from: options.from ?? "porch-conformance",
  };
  const limitMs = driver.timeouts.caseMs + (c.slow ? (driver.timeouts.idleStopMs ?? 0) : 0);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`case took longer than ${limitMs} ms`)), limitMs);
  });
  const work = (async () => {
    await driver.setup({ env, workDir, adapter, adapterContext: porch.ctx });
    await c.run(ctx);
  })();
  try {
    await Promise.race([work, timeout]);
    if (snapshots.length > 0) await options.onFixture?.(newFixture(adapter.harness, harnessVersion, c.name, snapshots));
    return { result: "pass", reason: null };
  } catch (err) {
    if (err instanceof ConformanceSkip) return { result: "skip", reason: err.message };
    return { result: "fail", reason: errorMessage(err) };
  } finally {
    clearTimeout(timer);
    // After a timeout the case may still be running, for example still starting a
    // session. Give it up to caseMs more to finish, so a session it starts late is
    // stopped by cleanup instead of left running.
    await settleWithin(work, driver.timeouts.caseMs);
    await driver.cleanup().catch((err) => options.log?.(`cleanup failed for ${c.name}: ${errorMessage(err)}`));
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Wait for `p` to settle, or `ms`, whichever comes first. Never throws. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

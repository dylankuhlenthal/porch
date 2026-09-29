/**
 * The conformance command's logic, separate from main.ts so tests can run it with
 * their own drivers and environment.
 *
 * `npm run conformance -- --harness <h> [--record] [--case <name>]...`
 *
 * Runs the conformance suite against one harness on this machine and prints the
 * report as JSON on stdout (progress goes to stderr). With --record, also writes
 * the fixtures and the report into conformance/ under `root`. Exit codes:
 *   0 no case failed
 *   1 a case failed
 *   2 usage error, or the harness is not available here
 *   3 skipped: an environment variable the harness needs (such as an API key) is not set
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { errorMessage } from "../fsutil.js";
import type { Env } from "../home.js";
import { Porch } from "../porch.js";
import type { DriverEntry } from "./drivers/index.js";
import { fixturePath, reportPath } from "./paths.js";
import { runConformance } from "./runner.js";

export const CONFORMANCE_EXIT = { passed: 0, failed: 1, usage: 2, skipped: 3 } as const;

export interface ConformanceCommandIO {
  env: Env;
  root: string;
  drivers: Record<string, DriverEntry>;
  stdout(text: string): void;
  stderr(text: string): void;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

export async function conformanceCommand(argv: string[], io: ConformanceCommandIO): Promise<number> {
  let values: { harness?: string; record?: boolean; case?: string[] };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { harness: { type: "string" }, record: { type: "boolean" }, case: { type: "string", multiple: true } },
    }));
  } catch (err) {
    io.stderr(`${errorMessage(err)}\n`);
    return CONFORMANCE_EXIT.usage;
  }
  const harness = values.harness;
  const entry = harness === undefined ? undefined : io.drivers[harness];
  if (harness === undefined || entry === undefined) {
    io.stderr(`usage: npm run conformance -- --harness <${Object.keys(io.drivers).join("|")}> [--record] [--case <name>]...\n`);
    return CONFORMANCE_EXIT.usage;
  }
  const missing = entry.requiredEnv.filter((k) => !io.env[k]);
  if (missing.length > 0) {
    io.stdout(JSON.stringify({ schema: 1, harness, skipped: `not set: ${missing.join(", ")}` }) + "\n");
    return CONFORMANCE_EXIT.skipped;
  }
  const adapter = entry.adapter();
  const baseEnv: Env = {
    PATH: io.env.PATH,
    HOME: io.env.HOME,
    ...Object.fromEntries(entry.requiredEnv.map((k) => [k, io.env[k]])),
  };
  const detected = await adapter.detect(new Porch({ env: baseEnv, adapters: [adapter] }).ctx).catch((err: unknown) => ({
    available: false,
    reason: errorMessage(err),
  }));
  if (!detected.available && entry.needsInstalledHarness) {
    io.stderr(`${harness} is not available here: ${detected.reason}\n`);
    return CONFORMANCE_EXIT.usage;
  }
  let report;
  try {
    report = await runConformance({
      adapter,
      driver: entry.driver(),
      cases: values.case,
      baseEnv,
      log: (line) => io.stderr(`${line}\n`),
      onFixture: values.record ? (f) => writeJson(fixturePath(io.root, harness, f.case), f) : undefined,
    });
  } catch (err) {
    io.stderr(`${errorMessage(err)}\n`);
    return CONFORMANCE_EXIT.usage;
  }
  if (values.record) await writeJson(reportPath(io.root, harness), report);
  io.stdout(JSON.stringify(report, null, 2) + "\n");
  return report.passed ? CONFORMANCE_EXIT.passed : CONFORMANCE_EXIT.failed;
}

/**
 * Record and replay of what a harness returned.
 *
 * During a conformance run, the suite's adapter context uses a RecordingIO, and at
 * chosen points a case takes a snapshot: the session records in the scratch
 * folder, every outside read the adapter made while listing (commands run, files
 * read, with their results), and the observations the adapter produced from them.
 * A case's snapshots are saved as one fixture file.
 *
 * The per-PR tests replay every fixture (replayFixture): write the records into a
 * fresh scratch folder, answer the adapter's outside reads from the recording,
 * run `list`, and require the same observations. So a PR that changes how an
 * adapter reads harness output is checked against real output without the harness.
 *
 * Paths are stored with placeholders ($PORCH_HOME, $WORK, $HOME) so a fixture
 * replays anywhere and does not carry the recording machine's home folder.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Adapter, AdapterContext } from "../adapter.js";
import type { Env } from "../home.js";
import { porchHome, sessionsDir } from "../home.js";
import type { HarnessIO, RunOptions, RunResult } from "../io.js";
import { RecordStore } from "../records.js";
import { SCHEMA_VERSION, type Observation, type SchemaVersion } from "../types.js";

export type IOCall =
  | { op: "run"; cmd: string; args: string[]; result: RunResult }
  | { op: "readFile"; path: string; result: string | null };

export interface Snapshot {
  label: string;
  /** The clock during the listing; replay uses it as `now`. */
  at: string;
  /** Record file contents keyed by file name. */
  records: Record<string, unknown>;
  io: IOCall[];
  observations: Observation[];
}

export interface Fixture {
  schema: SchemaVersion;
  harness: string;
  harnessVersion: string | null;
  case: string;
  recordedAt: string;
  snapshots: Snapshot[];
}

/** Wraps a HarnessIO and keeps every call and its result. */
export class RecordingIO implements HarnessIO {
  calls: IOCall[] = [];

  constructor(private readonly inner: HarnessIO) {}

  async run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult> {
    const result = await this.inner.run(cmd, args, options);
    this.calls.push({ op: "run", cmd, args: [...args], result });
    return result;
  }

  async readFile(file: string): Promise<string | null> {
    const result = await this.inner.readFile(file);
    this.calls.push({ op: "readFile", path: file, result });
    return result;
  }

  take(): IOCall[] {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }
}

/** Answers outside reads from a recording. A read that was not recorded is an error. */
export class ReplayIO implements HarnessIO {
  private readonly remaining: IOCall[];

  constructor(calls: IOCall[]) {
    this.remaining = [...calls];
  }

  async run(cmd: string, args: string[]): Promise<RunResult> {
    const i = this.remaining.findIndex((c) => c.op === "run" && c.cmd === cmd && sameArgs(c.args, args));
    if (i < 0) throw new Error(`replay: no recorded result for command ${JSON.stringify([cmd, ...args])}`);
    const [call] = this.remaining.splice(i, 1);
    return (call as Extract<IOCall, { op: "run" }>).result;
  }

  async readFile(file: string): Promise<string | null> {
    const i = this.remaining.findIndex((c) => c.op === "readFile" && c.path === file);
    if (i < 0) throw new Error(`replay: no recorded result for reading ${file}`);
    const [call] = this.remaining.splice(i, 1);
    return (call as Extract<IOCall, { op: "readFile" }>).result;
  }
}

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Placeholder substitutions, longest path first so nested folders map correctly. */
function substitutions(env: Env, workDir: string | null): [string, string][] {
  const pairs: [string, string][] = [
    [porchHome(env), "$PORCH_HOME"],
    ...(workDir ? ([[workDir, "$WORK"]] as [string, string][]) : []),
    [env.HOME ?? os.homedir(), "$HOME"],
    [os.homedir(), "$HOME"],
  ];
  return pairs.filter(([p]) => p.length > 1).sort((x, y) => y[0].length - x[0].length);
}

/** Replace machine paths with placeholders in every string inside `value`. */
export function toPlaceholders<T>(value: T, env: Env, workDir: string | null): T {
  const subs = substitutions(env, workDir);
  return mapStrings(value, (s) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), s));
}

/** Expand placeholders back into this machine's paths. */
export function fromPlaceholders<T>(value: T, env: Env, workDir: string): T {
  const map: Record<string, string> = { $PORCH_HOME: porchHome(env), $WORK: workDir, $HOME: env.HOME ?? os.homedir() };
  return mapStrings(value, (s) => s.replace(/\$(PORCH_HOME|WORK|HOME)/g, (m) => map[m] ?? m));
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fn(k), mapStrings(v, fn)])) as T;
  }
  return value;
}

/** Take one snapshot: the records as they are now, and a listing through the recording io. */
export async function takeSnapshot(
  label: string,
  adapter: Adapter,
  ctx: AdapterContext,
  io: RecordingIO,
  workDir: string,
): Promise<Snapshot> {
  const records: Record<string, unknown> = {};
  let names: string[] = [];
  try {
    names = await fs.readdir(ctx.records.dir);
  } catch {
    // no records folder yet
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      records[name] = JSON.parse(await fs.readFile(path.join(ctx.records.dir, name), "utf8"));
    } catch {
      // removed or replaced between readdir and read: leave it out
    }
  }
  io.take();
  const at = ctx.now().toISOString();
  const frozen: AdapterContext = { ...ctx, now: () => new Date(at) };
  const observations = await adapter.list(frozen);
  return toPlaceholders({ label, at, records, io: io.take(), observations }, ctx.env, workDir);
}

export interface ReplayMismatch {
  snapshot: string;
  expected: Observation[];
  actual: Observation[] | { error: string };
}

/**
 * Replay a fixture against an adapter. Returns one entry per snapshot whose
 * observations differ from the recording (empty: the adapter still agrees).
 */
export async function replayFixture(
  fixture: Fixture,
  adapter: Adapter,
  scratch: { env: Env; workDir: string },
): Promise<ReplayMismatch[]> {
  const mismatches: ReplayMismatch[] = [];
  for (const raw of fixture.snapshots) {
    const snap = fromPlaceholders(raw, scratch.env, scratch.workDir);
    const dir = sessionsDir(scratch.env);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    for (const [name, contents] of Object.entries(snap.records)) {
      await fs.writeFile(path.join(dir, name), JSON.stringify(contents));
    }
    const ctx: AdapterContext = {
      env: scratch.env,
      home: porchHome(scratch.env),
      records: new RecordStore(dir, { now: () => new Date(snap.at) }),
      io: new ReplayIO(snap.io),
      now: () => new Date(snap.at),
    };
    let actual: Observation[] | { error: string };
    try {
      actual = await adapter.list(ctx);
    } catch (err) {
      actual = { error: err instanceof Error ? err.message : String(err) };
    }
    if (JSON.stringify(actual) !== JSON.stringify(snap.observations)) {
      mismatches.push({ snapshot: raw.label, expected: snap.observations, actual });
    }
  }
  return mismatches;
}

export function newFixture(harness: string, harnessVersion: string | null, caseName: string, snapshots: Snapshot[]): Fixture {
  return { schema: SCHEMA_VERSION, harness, harnessVersion, case: caseName, recordedAt: new Date().toISOString(), snapshots };
}

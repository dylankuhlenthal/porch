/**
 * Record and replay of what a harness returned.
 *
 * During a conformance run, the suite's adapter context uses a RecordingIO, and at
 * chosen points a case takes a snapshot: a copy of the session records in the
 * scratch folder, every outside read the adapter made while listing (commands run,
 * files read, with their results), and the observations the adapter produced from
 * them. The adapter lists against the copy, so the records and the observations
 * always agree (takeSnapshot).
 * A case's snapshots are saved as one fixture file.
 *
 * The per-PR tests replay every fixture (replayFixture): write the records into a
 * fresh scratch folder, answer the adapter's outside reads from the recording,
 * run `list`, and require the same observations. So a PR that changes how an
 * adapter reads harness output is checked against real output without the harness.
 *
 * Paths are stored with placeholders ($PORCH_HOME, $WORK, $HOME, and $WORK_DASHED
 * and $HOME_DASHED for the same paths turned into one folder name) so a fixture
 * replays anywhere and does not carry the recording machine's home folder, and
 * the values of the extra environment variables a harness needs (its API key)
 * are replaced with $REDACTED. Other harness output is kept as recorded.
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

/**
 * A path as some harnesses turn it into a single folder name: every character
 * other than a letter or digit becomes "-" (Claude Code names its transcript
 * folders like this, for example "-Users-me-work").
 */
export function dashedPath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

/** Placeholder substitutions, longest path first so nested folders map correctly. */
function substitutions(env: Env, workDir: string | null): [string, string][] {
  const homes = [env.HOME ?? os.homedir(), os.homedir()];
  const pairs: [string, string][] = [
    [porchHome(env), "$PORCH_HOME"],
    ...(workDir ? ([[workDir, "$WORK"], [dashedPath(workDir), "$WORK_DASHED"]] as [string, string][]) : []),
    ...homes.flatMap((h): [string, string][] => [[h, "$HOME"], [dashedPath(h), "$HOME_DASHED"]]),
  ];
  return pairs.filter(([p]) => p.length > 1).sort((x, y) => y[0].length - x[0].length);
}

/**
 * Replace machine paths with placeholders in every string inside `value`, and
 * any of `secrets` (such as the API key a harness needs) with `$REDACTED`.
 */
export function toPlaceholders<T>(value: T, env: Env, workDir: string | null, secrets: string[] = []): T {
  const redact: [string, string][] = secrets.filter((x) => x.length >= 8).map((x) => [x, "$REDACTED"]);
  const subs = [...redact, ...substitutions(env, workDir)];
  return mapStrings(value, (s) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), s));
}

/** Expand placeholders back into this machine's paths. */
export function fromPlaceholders<T>(value: T, env: Env, workDir: string): T {
  const home = env.HOME ?? os.homedir();
  const map: Record<string, string> = {
    $PORCH_HOME: porchHome(env),
    $WORK_DASHED: dashedPath(workDir),
    $WORK: workDir,
    $HOME_DASHED: dashedPath(home),
    $HOME: home,
  };
  // Longer names first, so $WORK_DASHED is not read as $WORK followed by "_DASHED".
  return mapStrings(value, (s) => s.replace(/\$(PORCH_HOME|WORK_DASHED|WORK|HOME_DASHED|HOME)/g, (m) => map[m] ?? m));
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fn(k), mapStrings(v, fn)])) as T;
  }
  return value;
}

/**
 * Take one snapshot: copy the records as they are now, and list through the
 * recording io.
 *
 * The adapter lists against the copy, written into a private folder exactly as
 * replay writes it, never against the live records folder. A record that changes
 * while the snapshot is taken (a session's inside part writing as it is held at a
 * prompt, for example) then cannot leave the fixture holding one version of the
 * record and observations made from another, so every snapshot replays.
 */
export async function takeSnapshot(
  label: string,
  adapter: Adapter,
  ctx: AdapterContext,
  io: RecordingIO,
  workDir: string,
  secrets: string[] = [],
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
  const copyDir = await fs.mkdtemp(path.join(os.tmpdir(), "porch-snapshot-"));
  try {
    await writeRecords(copyDir, records);
    io.take();
    const at = ctx.now().toISOString();
    const frozen: AdapterContext = {
      ...ctx,
      records: new RecordStore(copyDir, { now: () => new Date(at) }),
      now: () => new Date(at),
    };
    const observations = await adapter.list(frozen);
    // Anything that names the copy's folder is saved as naming the live records folder, which becomes $PORCH_HOME.
    const snap = mapStrings({ label, at, records, io: io.take(), observations }, (s) => s.split(copyDir).join(ctx.records.dir));
    return toPlaceholders(snap, ctx.env, workDir, secrets);
  } finally {
    await fs.rm(copyDir, { recursive: true, force: true });
  }
}

/** Write a snapshot's records into `dir`, one file each. Recording and replay both list against records written this way. */
async function writeRecords(dir: string, records: Record<string, unknown>): Promise<void> {
  for (const [name, contents] of Object.entries(records)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(contents));
  }
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
    await writeRecords(dir, snap.records);
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

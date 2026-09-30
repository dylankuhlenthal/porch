/**
 * Harness drivers the conformance command knows, by harness name. A new adapter
 * adds its driver here next to its entry in src/adapters/index.ts.
 */
import { execFile } from "node:child_process";
import path from "node:path";

import type { Adapter } from "../../adapter.js";
import { createClaudeAdapter } from "../../adapters/claude/index.js";
import { claudeBin } from "../../adapters/claude/listing.js";
import type { Env } from "../../home.js";
import { createFakeAdapter } from "../../adapters/fake/index.js";
import { createPiAdapter } from "../../adapters/pi/index.js";
import { piBin } from "../../adapters/pi/launch.js";
import type { HarnessDriver } from "../driver.js";
import type { Snapshot } from "../recorder.js";
import { createClaudeDriver } from "./claude.js";
import { createFakeDriver } from "./fake.js";
import { createPiDriver, DEFAULT_PI_MODEL } from "./pi.js";

export interface DriverEntry {
  adapter(): Adapter;
  driver(): HarnessDriver;
  /** Environment variables the harness needs to run real turns (for example an API key); empty when none. */
  requiredEnv: string[];
  /** Refuse to run when the adapter's detect says the harness is not installed. False only for the fake. */
  needsInstalledHarness: boolean;
  /**
   * Environment variables passed to sessions when they are set, but not required
   * (for example an API key where a logged-in harness works without one). Their
   * values are kept out of fixtures like `requiredEnv`'s.
   */
  optionalEnv?: string[];
  /**
   * Why real turns cannot run here (for example: not logged in and no API key), or
   * null when they can. A reason makes the run exit 3, skipped, like a missing
   * required variable. Gets the environment sessions would start with.
   */
  unavailableReason?(env: Env): Promise<string | null>;
  /**
   * The folder each case's scratch folder is made in. Default: the system temp
   * folder. A harness that only runs sessions in folders it trusts (Claude Code)
   * points this at such a folder.
   */
  workRoot?(): string;
  /**
   * Remove from a recorded snapshot (paths already replaced by placeholders) any
   * harness output that is not about the case, such as other sessions running on
   * the machine, before it goes into a fixture. It must not change what the
   * adapter makes of the snapshot on replay.
   */
  scrubSnapshot?(snapshot: Snapshot): Snapshot;
}

/** Keep only the case's own sessions (working folder under $WORK) in recorded `claude agents --json` output. */
export function scrubClaudeSnapshot(snapshot: Snapshot): Snapshot {
  const io = snapshot.io.map((call) => {
    if (call.op !== "run" || call.args[0] !== "agents" || call.result.code !== 0) return call;
    let rows: unknown;
    try {
      rows = JSON.parse(call.result.stdout);
    } catch {
      return call;
    }
    if (!Array.isArray(rows)) return call;
    const kept = rows.filter((r) => {
      const cwd = (r as { cwd?: unknown } | null)?.cwd;
      return typeof cwd === "string" && (cwd === "$WORK" || cwd.startsWith("$WORK/"));
    });
    return { ...call, result: { ...call.result, stdout: JSON.stringify(kept, null, 2) + "\n" } };
  });
  return { ...snapshot, io };
}

/** Real turns need Claude Code logged in, or ANTHROPIC_API_KEY (as in the scheduled workflow). */
async function claudeUnavailable(env: Env): Promise<string | null> {
  if (env.ANTHROPIC_API_KEY) return null;
  const out = await new Promise<string>((resolve) => {
    execFile(claudeBin(env), ["auth", "status", "--json"], { env: env as NodeJS.ProcessEnv, timeout: 30000 }, (_err, stdout) => resolve(stdout ?? ""));
  });
  try {
    if ((JSON.parse(out) as { loggedIn?: unknown }).loggedIn === true) return null;
  } catch {
    // not JSON: treat as not logged in
  }
  return "Claude Code is not logged in and ANTHROPIC_API_KEY is not set";
}

/**
 * Real turns need Pi logged in to the driver's model provider (in Pi's own config
 * folder, or an API key variable such as OPENAI_API_KEY). `pi auth check` answers
 * without running a turn.
 */
async function piUnavailable(env: Env): Promise<string | null> {
  const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(piBin(env), ["auth", "check", "--model", DEFAULT_PI_MODEL, "--json"], { env: env as NodeJS.ProcessEnv, timeout: 30000 }, (err, stdout) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, out: stdout ?? "" }),
    );
  });
  if (r.code === 0) return null;
  let status: unknown = null;
  try {
    status = (JSON.parse(r.out) as { status?: unknown }).status;
  } catch {
    // not JSON: Pi itself failed, which is not a reason to skip
  }
  // Skip only when Pi says it has no usable login. Any other failure (Pi not
  // starting, for example on too old a Node) lets the run go ahead and fail loudly.
  if (status !== "not_ready" && status !== "invalid") return null;
  return `Pi is not logged in to ${DEFAULT_PI_MODEL} (\`pi auth check\` said ${r.out.trim()})`;
}

export const DRIVERS: Record<string, DriverEntry> = {
  claude: {
    // Each case's sessions run under its scratch folder (the parent of its
    // PORCH_HOME), and the adapter sees only those; scrubSnapshot drops every other
    // session on the machine from the recorded `claude agents --json` output.
    adapter: () => createClaudeAdapter({ pollIntervalMs: 1000, onlyUnder: (ctx) => path.dirname(ctx.home) }),
    scrubSnapshot: scrubClaudeSnapshot,
    driver: () => createClaudeDriver(),
    requiredEnv: [],
    optionalEnv: ["ANTHROPIC_API_KEY"],
    unavailableReason: claudeUnavailable,
    needsInstalledHarness: true,
    // Claude Code runs background sessions only in folders the person trusts; run
    // the suite from a checkout inside a trusted folder (docs/patterns/conformance.md).
    // .conformance-tmp/ is ignored by git.
    workRoot: () => path.join(process.cwd(), ".conformance-tmp"),
  },
  pi: {
    adapter: () => createPiAdapter({ pollIntervalMs: 1000 }),
    driver: () => createPiDriver(),
    requiredEnv: [],
    // Pi also reads provider keys from the environment; a logged-in Pi needs none.
    optionalEnv: ["OPENAI_API_KEY"],
    unavailableReason: piUnavailable,
    needsInstalledHarness: true,
  },
  fake: { adapter: () => createFakeAdapter({ pollIntervalMs: 200 }), driver: createFakeDriver, requiredEnv: [], needsInstalledHarness: false },
};

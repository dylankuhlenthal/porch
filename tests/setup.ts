/**
 * Runs before every test file. Points PORCH_HOME and HOME at scratch folders so no
 * test can write to the real ~/.porch, ~/.claude, ~/.claude.json or ~/.sous-chef,
 * even one that forgets to pass its own env, and keeps them from running the real
 * `claude` or `pi`.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NO_CLAUDE, NO_PI } from "./helpers.js";

const realHome = os.homedir();
const scratch = mkdtempSync(path.join(os.tmpdir(), "porch-test-"));
process.env.HOME = path.join(scratch, "home");
process.env.PORCH_HOME = path.join(scratch, "porch-home");
delete process.env.PORCH_FAKE_STATE;
delete process.env.PORCH_FAKE_SESSION_ID;
// A test run from inside a Claude Code session must not see that session: the
// Claude adapter would claim it as the current session.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_") || key === "CLAUDECODE") delete process.env[key];
}
// Likewise for a run from inside a Pi session (its bash tool sets PI_SESSION_ID).
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_")) delete process.env[key];
}
// Never run the real `claude` from per-PR tests: it would list the real sessions
// on this machine. Tests that need Claude Code output give the adapter a HarnessIO.
process.env.PORCH_CLAUDE_BIN = NO_CLAUDE;
process.env.PORCH_PI_BIN = NO_PI;

if (process.env.PORCH_HOME.startsWith(path.join(realHome, ".porch"))) {
  throw new Error("tests must never use the real ~/.porch");
}

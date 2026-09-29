/**
 * Runs before every test file. Points PORCH_HOME and HOME at scratch folders so no
 * test can write to the real ~/.porch, ~/.claude, ~/.claude.json or ~/.sous-chef,
 * even one that forgets to pass its own env.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const realHome = os.homedir();
const scratch = mkdtempSync(path.join(os.tmpdir(), "porch-test-"));
process.env.HOME = path.join(scratch, "home");
process.env.PORCH_HOME = path.join(scratch, "porch-home");
delete process.env.PORCH_FAKE_STATE;
delete process.env.PORCH_FAKE_SESSION_ID;

if (process.env.PORCH_HOME.startsWith(path.join(realHome, ".porch"))) {
  throw new Error("tests must never use the real ~/.porch");
}

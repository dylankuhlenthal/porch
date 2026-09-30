/**
 * The pseudo-terminal the launch-interactive case runs a real harness in, shared by
 * the harness drivers. node-pty is a dev dependency, loaded only when that case runs,
 * so the published package does not need it.
 */
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * node-pty, loaded only when an interactive case runs: it is a dev dependency, so the
 * published package does not need it. Its macOS prebuilds (1.1.0) ship spawn-helper
 * without the execute bit, which makes every spawn fail with "posix_spawnp failed",
 * so it is set here if missing.
 */
export async function loadPty(): Promise<typeof import("node-pty")> {
  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (err) {
    throw new Error(`the interactive launch case needs node-pty (a dev dependency; run npm ci): ${String(err)}`);
  }
  const require = createRequire(import.meta.url);
  const dir = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`);
  const helper = path.join(dir, "spawn-helper");
  const mode = await fs.stat(helper).then((st) => st.mode, () => null);
  if (mode !== null && (mode & 0o111) === 0) await fs.chmod(helper, mode | 0o755);
  return pty;
}

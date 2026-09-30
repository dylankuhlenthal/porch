import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

/**
 * Porch's own folder: $PORCH_HOME, or ~/.porch. Tests always set PORCH_HOME to a
 * scratch folder so they never touch the real one.
 */
export function porchHome(env: Env): string {
  const fromEnv = env.PORCH_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : os.homedir();
  return path.join(home, ".porch");
}

/** Where session records live: <porch home>/sessions. */
export function sessionsDir(env: Env): string {
  return path.join(porchHome(env), "sessions");
}

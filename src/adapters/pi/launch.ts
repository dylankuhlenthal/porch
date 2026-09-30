/**
 * `porch launch pi [pi arguments...]`: Pi with Porch's extension loaded for this one
 * session (`pi -e <extension>`, the arguments `porch extension pi` prints), and the
 * caller's arguments passed through unchanged.
 *
 * `-e` goes first, before anything of the caller's, so it cannot land after a `--`
 * (where Pi would read it as the prompt). The exception is Pi's own subcommands:
 * Pi takes a subcommand only as the first argument (`pi list`, `pi install ...`), and
 * with `-e` in front it reads `list` as a prompt and starts a session instead
 * (observed with 0.87.1). A subcommand starts no session, so there is nothing to
 * attach: its arguments are passed through as they are.
 *
 * The records folder reaches the extension through PORCH_HOME in Pi's environment,
 * which `porch launch --porch-home` sets; Pi starts as a fresh process each time, so
 * there is no earlier environment to override (unlike `claude --bg`).
 */
import { fileURLToPath } from "node:url";

import type { AdapterContext, LaunchPlan } from "../../adapter.js";

/** Pi's subcommands in 0.87.1 (`pi --help`, and `main` in Pi's dist/main.js). */
export const PI_SUBCOMMANDS = ["install", "remove", "uninstall", "update", "list", "config", "auth"] as const;

/** The `pi` command: PORCH_PI_BIN, or `pi` on PATH. */
export function piBin(env: AdapterContext["env"]): string {
  const v = env.PORCH_PI_BIN;
  return v && v.trim() !== "" ? v : "pi";
}

/**
 * The built extension (dist/adapters/pi/extension.js) of this Porch. When this file
 * runs from source (the per-PR tests), that is the build in dist/, which `npm test`
 * makes first.
 */
export function piExtensionPath(): string {
  const fromSource = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(fromSource ? "../../../dist/adapters/pi/extension.js" : "./extension.js", import.meta.url));
}

/**
 * The Pi arguments that load Porch's extension for one session. `porch extension pi`
 * prints them and `porch launch pi` adds them, so both always name the same file.
 */
export function piExtensionArgs(): string[] {
  return ["-e", piExtensionPath()];
}

export async function piLaunchPlan(ctx: AdapterContext, args: string[]): Promise<LaunchPlan> {
  const command = piBin(ctx.env);
  const first = args[0];
  if (first !== undefined && (PI_SUBCOMMANDS as readonly string[]).includes(first)) return { command, args: [...args] };
  return { command, args: [...piExtensionArgs(), ...args] };
}

import { fileURLToPath } from "node:url";

/**
 * The built CLI (dist/cli/main.js) of this Porch, so hook commands and launch plans
 * run this exact Porch, whatever is on the session's PATH.
 */
export function porchCliPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}

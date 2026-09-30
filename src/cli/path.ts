import { fileURLToPath } from "node:url";

/**
 * The built CLI (dist/cli/main.js) of this Porch, so hook commands and launch plans
 * run this exact Porch, whatever is on the session's PATH. When this file runs from
 * source (the per-PR tests run src/ directly), that is the build in dist/, which
 * `npm test` makes first.
 */
export function porchCliPath(): string {
  const fromSource = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(fromSource ? "../../dist/cli/main.js" : "./main.js", import.meta.url));
}

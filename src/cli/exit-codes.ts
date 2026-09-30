/**
 * Exit codes of the `porch` command. Consumers rely on these; changing one is a
 * breaking change (bump SCHEMA_VERSION). docs/reference/cli-output.md explains each.
 */
import type { ErrorCode } from "../types.js";

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  notFound: 3,
  /** `porch deliver` ran but the result was not-running or failed. The result JSON is still printed. */
  notDelivered: 4,
  notInSession: 5,
  ambiguousSession: 6,
} as const;

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "usage":
      return EXIT.usage;
    case "not-found":
      return EXIT.notFound;
    case "not-in-session":
      return EXIT.notInSession;
    case "ambiguous-session":
      return EXIT.ambiguousSession;
    case "internal":
      return EXIT.internal;
  }
}

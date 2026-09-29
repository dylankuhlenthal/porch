/**
 * The adapters Porch ships. A new harness adapter is added to this list (and gets
 * its own folder under src/adapters/). Order matters only for output order.
 */
import type { Adapter } from "../adapter.js";
import { createFakeAdapter } from "./fake/index.js";

export function builtinAdapters(): Adapter[] {
  return [createFakeAdapter()];
}

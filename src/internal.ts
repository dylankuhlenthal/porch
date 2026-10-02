/**
 * @dylankuhlenthal/porch/internal: everything that is not part of the supported library
 * (docs/reference/library.md): the adapter contract's parts, the built-in adapters, the
 * record store's errors and checks, watch, and the CLI itself. Exported for Porch's own
 * tools and for experiments. Not covered by the version rules: any of it may change or go
 * in any release.
 */
export * from "./adapter.js";
export { RecordError, InvalidIdError, CorruptRecordError, validateHarness, validateSessionId } from "./records.js";
export { watchSessions, comparisonKey } from "./watch.js";
export { builtinAdapters } from "./adapters/index.js";
export { runCli, type CliIO, type CliOptions } from "./cli/run.js";

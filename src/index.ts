/**
 * @dylankuhlenthal/porch: the library. The CLI (`porch`) is the primary interface;
 * this exposes the same operations, the adapter contract and the record store for
 * adapters and Node consumers. The conformance suite is at
 * `@dylankuhlenthal/porch/conformance`.
 */
export * from "./types.js";
export * from "./adapter.js";
export { Porch, formatMessage, MAX_FROM_LENGTH, type PorchOptions } from "./porch.js";
export { PorchError } from "./errors.js";
export { RecordStore, RecordError, InvalidIdError, CorruptRecordError, validateHarness, validateSessionId } from "./records.js";
export type { DeliveryAddress, InsidePart, SessionRecord, RecordProblem, RecordStoreOptions } from "./records.js";
export { porchHome, sessionsDir, type Env } from "./home.js";
export { realIO, type HarnessIO, type RunResult, type RunOptions } from "./io.js";
export { watchSessions, comparisonKey, type WatchOptions } from "./watch.js";
export { builtinAdapters } from "./adapters/index.js";
export { createFakeAdapter, FAKE_HARNESS, FAKE_SESSION_ENV } from "./adapters/fake/index.js";
export * as fake from "./adapters/fake/ops.js";
export { fakeStatePath } from "./adapters/fake/state.js";
export { runCli, type CliIO, type CliOptions } from "./cli/run.js";
export { EXIT } from "./cli/exit-codes.js";

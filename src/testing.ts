/**
 * @dylankuhlenthal/porch/testing: supported helpers for testing code built on Porch
 * without a real harness. The fake adapter and its operations (`docs/domains/fake-adapter.md`),
 * and the record store, to read or write session records in a scratch `PORCH_HOME`. Listed
 * in docs/reference/library.md and covered by its version rules.
 */
export { createFakeAdapter, FAKE_HARNESS, FAKE_SESSION_ENV } from "./adapters/fake/index.js";
export * as fake from "./adapters/fake/ops.js";
export { fakeStatePath } from "./adapters/fake/state.js";
export { RecordStore } from "./records.js";
export type { DeliveryAddress, InsidePart, SessionRecord, RecordProblem, RecordStoreOptions } from "./records.js";
export type { Adapter, AdapterContext } from "./adapter.js";

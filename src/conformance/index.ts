/**
 * @dylankuhlenthal/porch/conformance: the conformance suite, the harness driver
 * interface and record-and-replay, for adapter authors.
 */
export * from "./driver.js";
export { CASES, check, ConformanceFailure, ConformanceSkip, type CaseContext, type ConformanceCase } from "./cases.js";
export { runConformance, type CaseResult, type ConformanceOptions, type ConformanceReport } from "./runner.js";
export {
  RecordingIO,
  ReplayIO,
  replayFixture,
  takeSnapshot,
  toPlaceholders,
  fromPlaceholders,
  newFixture,
  type Fixture,
  type IOCall,
  type ReplayMismatch,
  type Snapshot,
} from "./recorder.js";
export { createFakeDriver } from "./drivers/fake.js";
export { DRIVERS, type DriverEntry } from "./drivers/index.js";
export { fixturePath, FIXTURES_DIR, REPORTS_DIR, reportPath } from "./paths.js";
export { conformanceCommand, CONFORMANCE_EXIT, type ConformanceCommandIO } from "./command.js";

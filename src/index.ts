/**
 * @dylankuhlenthal/porch: the supported library. The CLI (`porch`) is the primary
 * interface; this exposes the same operations for Node consumers. Every name exported
 * here is listed in docs/reference/library.md and follows its version rules
 * (tests/library-exports.test.ts keeps the two in step). Test helpers are at
 * `@dylankuhlenthal/porch/testing`; everything else is at `@dylankuhlenthal/porch/internal`
 * and may change in any release.
 */
export {
  SCHEMA_VERSION,
  SESSION_STATUSES,
  SELF_STATUSES,
  DELIVER_RESULTS,
  ERROR_CODES,
  notRunning,
  shownByDefault,
  type SchemaVersion,
  type SessionStatus,
  type SelfStatus,
  type SelfReport,
  type Observation,
  type DeliverResultKind,
  type DeliverResult,
  type CurrentResult,
  type ListResult,
  type StatusSetResult,
  type LaunchPlanResult,
  type ErrorCode,
  type ErrorResult,
} from "./types.js";
export { Porch, formatMessage, MAX_FROM_LENGTH, type PorchOptions } from "./porch.js";
export { PorchError } from "./errors.js";
export { porchHome, sessionsDir, type Env } from "./home.js";
export { realIO, type HarnessIO, type RunResult, type RunOptions } from "./io.js";
export { runLaunchPlan, signalExitCode, type LaunchOutcome } from "./launch.js";
export type { WatchOptions } from "./watch.js";
export { EXIT } from "./cli/exit-codes.js";

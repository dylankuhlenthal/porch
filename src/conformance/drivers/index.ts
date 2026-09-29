/**
 * Harness drivers the conformance command knows, by harness name. A new adapter
 * adds its driver here next to its entry in src/adapters/index.ts.
 */
import type { Adapter } from "../../adapter.js";
import { createFakeAdapter } from "../../adapters/fake/index.js";
import type { HarnessDriver } from "../driver.js";
import { createFakeDriver } from "./fake.js";

export interface DriverEntry {
  adapter(): Adapter;
  driver(): HarnessDriver;
  /** Environment variables the harness needs to run real turns (for example an API key); empty when none. */
  requiredEnv: string[];
  /** Refuse to run when the adapter's detect says the harness is not installed. False only for the fake. */
  needsInstalledHarness: boolean;
}

export const DRIVERS: Record<string, DriverEntry> = {
  fake: { adapter: () => createFakeAdapter({ pollIntervalMs: 200 }), driver: createFakeDriver, requiredEnv: [], needsInstalledHarness: false },
};

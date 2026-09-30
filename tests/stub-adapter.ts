import { deliverResult, type Adapter } from "../src/adapter.js";

/** A minimal adapter for testing the core, with every method overridable. */
export function stubAdapter(harness: string, overrides: Partial<Adapter> = {}): Adapter {
  return {
    harness,
    capabilities: { queuesWhileBusy: false, seesPrompts: false, outsideListing: false, insidePart: false, pollIntervalMs: null },
    inside: null,
    detect: async () => ({ available: true, version: "1", reason: null }),
    list: async () => [],
    observe: async () => null,
    current: async () => null,
    deliver: async (_ctx, session) => deliverResult({ harness, session, result: "delivered", statusAtSend: "idle", via: "stub" }),
    ...overrides,
  };
}

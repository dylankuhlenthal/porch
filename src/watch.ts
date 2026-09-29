/**
 * `porch watch`: stay running and report each change as an Observation.
 *
 * What triggers a fresh look:
 * - any change in the records folder (a file watch), so an inside part's write shows at once;
 * - any change to the extra paths an adapter names in `watchPaths`;
 * - a poll every `capabilities.pollIntervalMs` for adapters whose outside listing
 *   shows things no record does (a session dying without its end hook, a prompt opening);
 * - a slow backstop poll, because file watches can miss events on some systems.
 *
 * Each look asks the adapters for their listing and compares every session with
 * what was last reported, ignoring `raw`. A session that is new or changed is
 * reported; a session that disappears from its adapter's listing is reported once
 * as `gone` (with `since` and `detail` null, since neither is known) and then forgotten. An adapter whose listing fails keeps its last-reported sessions (no
 * false `gone`) and the error goes to `onError`.
 */
import { watch as fsWatch, promises as fs, type FSWatcher } from "node:fs";
import path from "node:path";

import { observation, type Adapter, type AdapterContext } from "./adapter.js";
import type { Observation } from "./types.js";

export interface WatchOptions {
  adapters: Adapter[];
  ctx: AdapterContext;
  /** Only this harness (the caller has already narrowed `adapters`; kept for the record). */
  harness?: string;
  /** Only this session id. */
  session?: string;
  onObservation(observation: Observation): void;
  onError?(harness: string, error: unknown): void;
  signal: AbortSignal;
  /** Look again at least this often even without file events. Default 5000. */
  backstopPollMs?: number;
  /** Wait this long after a file event before looking, so a burst of writes is one look. Default 25. */
  debounceMs?: number;
}

export async function watchSessions(options: WatchOptions): Promise<void> {
  const { adapters, ctx, signal } = options;
  if (signal.aborted) return;
  const debounceMs = options.debounceMs ?? 25;
  const last = new Map<string, { adapter: string; key: string; harness: string; session: string; self: Observation["self"] }>();
  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  let debounce: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let pending = false;

  const emit = (obs: Observation) => {
    if (!signal.aborted) options.onObservation(obs);
  };

  const look = async () => {
    for (const adapter of adapters) {
      let current: Observation[];
      try {
        current = await adapter.list(ctx);
      } catch (err) {
        options.onError?.(adapter.harness, err);
        continue;
      }
      if (options.session !== undefined) current = current.filter((o) => o.session === options.session);
      const seen = new Set<string>();
      for (const obs of current) {
        const id = `${obs.harness}\u0000${obs.session}`;
        seen.add(id);
        const key = comparisonKey(obs);
        if (last.get(id)?.key !== key) {
          // Keep only what the gone report below needs, not `raw`.
          last.set(id, { adapter: adapter.harness, key, harness: obs.harness, session: obs.session, self: obs.self });
          emit(obs);
        }
      }
      for (const [id, prev] of last) {
        if (prev.adapter !== adapter.harness || seen.has(id)) continue;
        // The session left its adapter's listing: report it once as gone, then
        // forget it, so a long-running watch does not keep every session ever seen.
        // When it went and what its detail was are not known, so both are null.
        last.delete(id);
        emit(observation({ harness: prev.harness, session: prev.session, status: "gone", self: prev.self }));
      }
    }
  };

  const refresh = (): void => {
    if (signal.aborted) return;
    if (running) {
      pending = true;
      return;
    }
    running = look()
      .catch((err) => options.onError?.("porch", err))
      .finally(() => {
        running = null;
        if (pending) {
          pending = false;
          refresh();
        }
      });
  };

  const trigger = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      refresh();
    }, debounceMs);
  };

  // File watches: the records folder, plus each adapter's extra paths.
  await fs.mkdir(ctx.records.dir, { recursive: true, mode: 0o700 });
  const targets: { dir: string; name: string | null }[] = [{ dir: ctx.records.dir, name: null }];
  for (const adapter of adapters) {
    for (const p of adapter.watchPaths?.(ctx) ?? []) {
      const isDir = await fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
      // A file is replaced by rename on every write, so watch its folder and filter by name.
      targets.push(isDir ? { dir: p, name: null } : { dir: path.dirname(p), name: path.basename(p) });
    }
  }
  for (const target of targets) {
    try {
      await fs.mkdir(target.dir, { recursive: true });
      const w = fsWatch(target.dir, (_event, filename) => {
        if (target.name === null || filename === null || String(filename) === target.name) trigger();
      });
      w.on("error", (err) => options.onError?.("porch", err));
      watchers.push(w);
    } catch (err) {
      options.onError?.("porch", err);
    }
  }

  // Polls: per adapter, and the backstop.
  for (const adapter of adapters) {
    const ms = adapter.capabilities.pollIntervalMs;
    if (ms !== null && ms > 0) timers.push(setInterval(refresh, ms));
  }
  timers.push(setInterval(refresh, options.backstopPollMs ?? 5000));

  refresh();

  // The signal may have aborted while the watches were being set up.
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  if (debounce) clearTimeout(debounce);
  for (const t of timers) clearInterval(t);
  for (const w of watchers) w.close();
  if (running) await running;
}

/** What watch compares: the observation without `raw`, with object keys in a fixed order. */
export function comparisonKey(obs: Observation): string {
  const { raw: _raw, ...rest } = obs;
  return canonicalJson(rest);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

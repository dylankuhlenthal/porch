/**
 * `porch watch`: stay running and report each change as an Observation.
 *
 * What triggers a fresh look:
 * - any change in the records folder (a file watch), so an inside part's write shows at once.
 *   Events for the lock and temp files a write makes next to a record are skipped
 *   (each look runs every adapter's listing, `claude agents --json` for Claude Code);
 *   an event without a file name, which some platforms send, still triggers a look;
 * - any change to the extra paths an adapter names in `watchPaths`;
 * - a poll every `capabilities.pollIntervalMs` for adapters whose outside listing
 *   shows things no record does (a session dying without its end hook, a prompt opening);
 * - a slow backstop poll, because file watches can miss events on some systems.
 *
 * Each look asks the adapters for their listing and compares every session with
 * what was last reported, ignoring `raw`. A session that is new or changed is
 * reported; a session that disappears from its adapter's listing is reported once
 * as `gone` (with `since` and `detail` null, since neither is known) and then
 * forgotten. One that was already reported as gone is forgotten without another
 * line. An adapter whose listing fails keeps its last-reported sessions (no
 * false `gone`) and the error goes to `onError`.
 *
 * Without `all`, only sessions Porch is attached to are reported (a session already
 * reported keeps being followed if it stops counting as attached, so it is not
 * reported gone while it still runs). With `session`, the named session is followed
 * whether attached or not, as `observe` does for a named session.
 *
 * With `session`, the id may be any id the adapter's `observe` accepts (a Claude
 * short id too): it is looked up in each look's listing through the adapter's
 * `sessionIdIn`, and the watch follows the full id found.
 */
import { watch as fsWatch, promises as fs, type FSWatcher } from "node:fs";
import path from "node:path";

import { observation, type Adapter, type AdapterContext } from "./adapter.js";
import { isHelperFile } from "./fsutil.js";
import type { Observation } from "./types.js";

export interface WatchOptions {
  adapters: Adapter[];
  ctx: AdapterContext;
  /** Only this harness (the caller has already narrowed `adapters`; kept for the record). */
  harness?: string;
  /**
   * Only this session: its full id, or any id the adapter's `observe` accepts (a Claude
   * short id). Followed whether it is attached or not, as `observe` does for a named session.
   */
  session?: string;
  /** Also report sessions Porch is not attached to (`attached: false`). Default: attached sessions only. */
  all?: boolean;
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
  const last = new Map<
    string,
    {
      adapter: string;
      key: string;
      harness: string;
      session: string;
      attached: boolean;
      status: Observation["status"];
      self: Observation["self"];
    }
  >();
  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  let debounce: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let pending = false;

  const emit = (obs: Observation) => {
    if (!signal.aborted) options.onObservation(obs);
  };

  // With `session`: the full id each adapter reported for it, once found. It is
  // kept after that, so the session is still followed once it has gone. The id is
  // looked up in the listing this look already has (the adapter's `sessionIdIn`),
  // never with a second listing.
  const resolved = new Map<string, string>();
  const sessionIdFor = (adapter: Adapter, current: Observation[]): string | null => {
    const wanted = options.session!;
    const known = resolved.get(adapter.harness);
    if (known !== undefined) return known;
    let id: string | null = current.some((o) => o.session === wanted) ? wanted : null;
    if (id === null && adapter.sessionIdIn) {
      try {
        id = adapter.sessionIdIn(wanted, current);
      } catch (err) {
        options.onError?.(adapter.harness, err);
        return null;
      }
    }
    if (id !== null) resolved.set(adapter.harness, id);
    return id;
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
      if (options.session !== undefined) {
        const id = sessionIdFor(adapter, current);
        current = id === null ? [] : current.filter((o) => o.session === id);
      } else if (!options.all) {
        // Attached sessions only, plus any already reported: a session that stops
        // counting as attached (a Claude session resumed without the hooks) is still
        // running, so it is followed until it leaves the listing rather than reported gone.
        current = current.filter((o) => o.attached || last.has(`${o.harness}\u0000${o.session}`));
      }
      const seen = new Set<string>();
      for (const obs of current) {
        const id = `${obs.harness}\u0000${obs.session}`;
        seen.add(id);
        const key = comparisonKey(obs);
        if (last.get(id)?.key !== key) {
          // Keep only what the gone report below needs, not `raw`.
          last.set(id, {
            adapter: adapter.harness,
            key,
            harness: obs.harness,
            session: obs.session,
            attached: obs.attached,
            status: obs.status,
            self: obs.self,
          });
          emit(obs);
        }
      }
      for (const [id, prev] of last) {
        if (prev.adapter !== adapter.harness || seen.has(id)) continue;
        // The session left its adapter's listing: report it once as gone, then
        // forget it, so a long-running watch does not keep every session ever seen.
        // When it went and what its detail was are not known, so both are null.
        // A session already reported as gone (a crash that left its record, later
        // cleaned up) is forgotten without a second, less informative gone line.
        last.delete(id);
        if (prev.status === "gone") continue;
        emit(observation({ harness: prev.harness, session: prev.session, attached: prev.attached, status: "gone", self: prev.self }));
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
  const targets: { dir: string; name: string | null; records?: true }[] = [{ dir: ctx.records.dir, name: null, records: true }];
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
        if (target.records ? recordsEventTriggersLook(filename) : target.name === null || filename === null || String(filename) === target.name) {
          trigger();
        }
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

/**
 * Does a file event in the records folder call for a look? Not for the lock and
 * temp files a write makes next to a record; yes for anything else, and for an
 * event without a file name (some platforms leave it out).
 */
export function recordsEventTriggersLook(filename: string | Buffer | null): boolean {
  return filename === null || !isHelperFile(String(filename));
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

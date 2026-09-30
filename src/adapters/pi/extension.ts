/**
 * The Pi adapter's inside part: a Pi extension that keeps each session's record up
 * to date and takes delivered messages. Pi loads it for one session with
 * `pi -e <this file, built>`, which is what `porch launch pi` adds.
 *
 * - session_start: open the socket (protocol.ts) and write the record: pid, when the
 *   process started, the socket address, cwd, status (idle, or busy if Pi is already
 *   running a turn), and in `data` the session file, Pi's mode and why it started.
 * - agent_start: busy, lastTurnStart. agent_settled: idle, lastTurnEnd. Pi documents
 *   agent_settled as the point after which it will not continue by itself (agent_end
 *   can be followed by retries, compaction or queued messages).
 * - ui_prompt_start / ui_prompt_end: an extension dialog opens or closes; the open
 *   one is `data.prompt` (Porch reports it as waiting-on-prompt).
 * - session_shutdown: mark the record ended (with Pi's reason: quit, new, resume,
 *   fork), then close the socket. On a reload the record is left as it is (the next
 *   session_start rewrites it), so the session does not seem to end.
 * - The process exiting (Node's `exit` event) without session_shutdown having
 *   finished: when Pi closes the terminal UI because the terminal went away while it
 *   was writing to it (a terminal window closed mid-turn), it exits with code 129
 *   without running session_shutdown. So on exit with code 0, 129 or 143 (a normal
 *   close: done, terminal gone or SIGHUP, SIGTERM), a session still open is marked
 *   ended synchronously, with no reason (Pi gave none) and the exit code in
 *   `data.exitCode`; and an ended mark session_shutdown started but could not finish
 *   is written synchronously too. Any other exit code (1: Pi crashed) leaves the
 *   record as it is, so the session shows as gone.
 * - A message on the socket goes to `pi.sendUserMessage(text, { deliverAs: "followUp" })`:
 *   it starts a turn when Pi is idle and waits for the current run when busy.
 *
 * The records folder is $PORCH_HOME (or ~/.porch) from Pi's environment; `porch launch
 * --porch-home` sets it there. Nothing here may disturb the session: every handler
 * catches its own errors, and a problem is kept in `data.lastError` where possible.
 *
 * The types below are the parts of Pi's ExtensionAPI this file uses, written by hand
 * against Pi 0.87.1 (`dist/core/extensions/types.d.ts` in @earendil-works/pi-coding-agent),
 * so Porch needs no dependency on Pi.
 */
import { promises as fs } from "node:fs";
import net from "node:net";

import { errorMessage } from "../../fsutil.js";
import { sessionsDir } from "../../home.js";
import { RecordStore, type InsidePart } from "../../records.js";
import { PI_HARNESS } from "./observe.js";
import {
  ensurePrivateDir,
  MAX_REQUEST_BYTES,
  parseRequest,
  piSocketDir,
  piSocketPath,
  replyLine,
  type PiReply,
  type PiSocketStatus,
} from "./protocol.js";

interface PiContext {
  mode: string;
  cwd: string;
  isIdle(): boolean;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}

interface PiEvent {
  type: string;
  reason?: string;
  kind?: string;
  title?: string;
}

export interface PiExtensionAPI {
  on(event: string, handler: (event: PiEvent, ctx: PiContext) => unknown): unknown;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

/** What the extension needs from outside, replaceable in tests. */
export interface ExtensionOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pid?: number;
  /** When this process started (ISO 8601). */
  processStartedAt?: string;
  socketDir?: string;
  /** How long a connection may take to send its request line before it is closed. */
  connectionTimeoutMs?: number;
  /** Where to listen for the process exiting (Node's `process`; tests pass their own). */
  exitEvents?: Pick<NodeJS.EventEmitter, "on">;
}

const EXIT_HANDLERS = Symbol.for("porch.pi.exitHandler");

/**
 * Run `handler` when `events` (the process) exits, in place of the handler an earlier
 * load of the extension set. Pi loads the extension again on every /reload, and only
 * the newest load has sessions to end; one listener per emitter runs the current
 * handler, rather than a new listener, and a kept old instance, each time.
 */
function onExit(events: Pick<NodeJS.EventEmitter, "on">, handler: (code: number) => void): void {
  const holder = events as { [EXIT_HANDLERS]?: { current: (code: number) => void } };
  const slot = holder[EXIT_HANDLERS];
  if (slot !== undefined) {
    slot.current = handler;
    return;
  }
  const fresh = { current: handler };
  holder[EXIT_HANDLERS] = fresh;
  events.on("exit", (code: number) => fresh.current(code));
}

/** How long a client of the socket may take to send its request line. */
export const CONNECTION_TIMEOUT_MS = 5000;

/**
 * Exit codes of a normal close of Pi (0.87.1): 0 (quit, Ctrl+C twice, Ctrl+D, SIGTERM
 * and SIGHUP in the terminal UI), 129 (the terminal went away) and 143 (SIGTERM in
 * print and RPC mode). Pi exits with 1 when it crashes.
 */
export const CLEAN_EXIT_CODES: readonly number[] = [0, 129, 143];

interface Live {
  session: string;
  ctx: PiContext;
  server: net.Server | null;
  address: string | null;
  /** Open connections, closed with the socket so a stalled client cannot hold up the session's end. */
  connections: Set<net.Socket>;
  /** Open extension dialogs, most recent last. */
  prompts: { kind: string | null; title: string | null; since: string }[];
}

export default function porchPiExtension(pi: PiExtensionAPI, options: ExtensionOptions = {}): void {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  // performance.timeOrigin is the wall-clock time the process started, fixed for its
  // life. (Now minus process.uptime() is not: uptime does not count time the machine
  // slept, so after a sleep and a /reload the start would be recorded too late.)
  const processStartedAt = options.processStartedAt ?? new Date(performance.timeOrigin).toISOString();
  const connectionTimeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;
  const records = new RecordStore(sessionsDir(env), { now });
  let live: Live | null = null;
  // Set while session_shutdown's ended mark has not been written yet.
  let ending: { session: string; reason: string | null; at: string } | null = null;
  // Record writes run one after another, in event order.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>): Promise<void> => {
    const next = queue.then(work).then(
      () => undefined,
      () => undefined,
    );
    queue = next;
    return next;
  };

  const update = (session: string, patch: InsidePart | ((current: InsidePart | null) => InsidePart), create = false) =>
    enqueue(async () => {
      try {
        if (create) await records.updateInside(PI_HARNESS, session, patch);
        else await records.updateInsideIfExists(PI_HARNESS, session, patch);
      } catch (err) {
        await records.updateInsideIfExists(PI_HARNESS, session, { data: { lastError: errorMessage(err) } }).catch(() => undefined);
      }
    });

  const statusNow = (l: Live): PiSocketStatus => (l.prompts.length > 0 ? "waiting-on-prompt" : l.ctx.isIdle() ? "idle" : "busy");

  const promptData = (l: Live) => {
    const top = l.prompts.at(-1);
    return top === undefined ? null : { kind: top.kind, title: top.title, since: top.since };
  };

  async function openSocket(l: Live): Promise<void> {
    const dir = options.socketDir ?? piSocketDir();
    await ensurePrivateDir(dir);
    const address = piSocketPath(pid, dir);
    // A socket file left by an earlier process with this pid (killed, so it never cleaned up).
    await fs.rm(address, { force: true });
    const server = net.createServer((conn) => handleConnection(l, conn));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", () => undefined);
    await fs.chmod(address, 0o600);
    l.server = server;
    l.address = address;
  }

  function handleConnection(l: Live, conn: net.Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    l.connections.add(conn);
    conn.on("close", () => l.connections.delete(conn));
    conn.on("error", () => undefined);
    // A client that never finishes its line is closed, so it holds nothing for long.
    conn.setTimeout(connectionTimeoutMs, () => conn.destroy());
    const answer = (reply: PiReply) => conn.end(replyLine(reply));
    conn.on("data", (chunk: Buffer) => {
      const nl = chunk.indexOf(0x0a);
      chunks.push(nl < 0 ? chunk : chunk.subarray(0, nl));
      size += nl < 0 ? chunk.length : nl;
      if (size > MAX_REQUEST_BYTES) {
        conn.removeAllListeners("data");
        answer({ ok: false, error: "request too long" });
        return;
      }
      if (nl < 0) return;
      conn.removeAllListeners("data");
      conn.setTimeout(0);
      const request = parseRequest(Buffer.concat(chunks).toString("utf8"));
      if (request === null) {
        answer({ ok: false, error: "not a deliver request" });
        return;
      }
      if (live !== l) {
        answer({ ok: false, error: "the session has ended" });
        return;
      }
      try {
        const status = statusNow(l);
        pi.sendUserMessage(request.text, { deliverAs: "followUp" });
        answer({ ok: true, status });
      } catch (err) {
        answer({ ok: false, error: errorMessage(err) });
      }
    });
  }

  async function closeSocket(l: Live): Promise<void> {
    const { server, address } = l;
    l.server = null;
    // server.close() waits for open connections, so end them first.
    for (const conn of l.connections) conn.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (address) await fs.rm(address, { force: true }).catch(() => undefined);
  }

  const safely =
    (fn: (event: PiEvent, ctx: PiContext) => Promise<void>) =>
    async (event: PiEvent, ctx: PiContext): Promise<void> => {
      try {
        await fn(event, ctx);
      } catch {
        // never disturb the session
      }
    };

  pi.on(
    "session_start",
    safely(async (event, ctx) => {
      const session = ctx.sessionManager.getSessionId();
      const l: Live = { session, ctx, server: null, address: null, connections: new Set(), prompts: [] };
      live = l;
      let socketError: string | null = null;
      try {
        await openSocket(l);
      } catch (err) {
        socketError = `could not open the delivery socket: ${errorMessage(err)}`;
      }
      await update(
        session,
        (current) => ({
          ...(current ?? {}),
          pid,
          // `since` is set by the record store when the status changes.
          status: ctx.isIdle() ? "idle" : "busy",
          delivery: l.address ? { via: "socket", address: l.address } : null,
          cwd: ctx.cwd,
          data: {
            ...(current?.data ?? {}),
            processStartedAt,
            sessionFile: ctx.sessionManager.getSessionFile() ?? null,
            mode: ctx.mode,
            source: event.reason ?? null,
            prompt: null,
            lastError: socketError,
          },
        }),
        true,
      );
    }),
  );

  pi.on(
    "agent_start",
    safely(async () => {
      if (live) await update(live.session, { status: "busy", lastTurnStart: now().toISOString() });
    }),
  );

  pi.on(
    "agent_settled",
    safely(async () => {
      if (live) await update(live.session, { status: "idle", lastTurnEnd: now().toISOString() });
    }),
  );

  pi.on(
    "ui_prompt_start",
    safely(async (event) => {
      if (!live) return;
      live.prompts.push({ kind: event.kind ?? null, title: event.title ?? null, since: now().toISOString() });
      await update(live.session, { data: { prompt: promptData(live) } });
    }),
  );

  pi.on(
    "ui_prompt_end",
    safely(async () => {
      if (!live) return;
      live.prompts.pop();
      await update(live.session, { data: { prompt: promptData(live) } });
    }),
  );

  pi.on(
    "session_shutdown",
    safely(async (event) => {
      const l = live;
      if (!l) return;
      live = null;
      if (event.reason !== "reload") {
        // Marked before the socket is closed, so it is already queued if Pi exits early.
        const end = { session: l.session, reason: event.reason ?? null, at: now().toISOString() };
        ending = end;
        // Cleared only once written: after a failed write the exit fallback tries again.
        void enqueue(async () => {
          try {
            await records.updateInsideIfExists(PI_HARNESS, end.session, { status: "ended", endedAt: end.at, endReason: end.reason });
            if (ending === end) ending = null;
          } catch (err) {
            await records.updateInsideIfExists(PI_HARNESS, end.session, { data: { lastError: errorMessage(err) } }).catch(() => undefined);
          }
        });
      }
      await closeSocket(l);
      await queue;
    }),
  );

  // The exit fallback (see the top of this file). Synchronous: nothing asynchronous
  // runs once the process is exiting.
  onExit(options.exitEvents ?? process, (code: number) => {
    // Both can apply: after /new, the old session's mark may still be unwritten while
    // the new session is live.
    try {
      if (ending !== null) {
        records.updateInsideIfExistsSync(PI_HARNESS, ending.session, { status: "ended", endedAt: ending.at, endReason: ending.reason });
      }
    } catch {
      // never disturb the session, even as it exits
    }
    try {
      if (live !== null && CLEAN_EXIT_CODES.includes(code)) {
        records.updateInsideIfExistsSync(PI_HARNESS, live.session, {
          status: "ended",
          endedAt: now().toISOString(),
          endReason: null,
          data: { exitCode: code },
        });
      }
    } catch {
      // never disturb the session, even as it exits
    }
  });
}

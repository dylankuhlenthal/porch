/**
 * How Porch talks to a Pi session: the extension (extension.ts) listens on a Unix
 * socket for the life of each session, and `deliver` (index.ts) connects, writes one
 * request line and reads one reply line. Pi has no outside way into a running
 * session, so Porch defines this protocol itself, on both ends.
 *
 *   request: {"type":"deliver","text":"<text>"}\n
 *   reply:   {"ok":true,"status":"idle"|"busy"|"waiting-on-prompt"}\n
 *        or  {"ok":false,"error":"<why>"}\n
 *
 * `status` is the session's own status at the moment the extension handed the text
 * to Pi (`pi.sendUserMessage` with `deliverAs: "followUp"`), so `statusAtSend` comes
 * from the session itself. A reply means Pi accepted the message, nothing more.
 *
 * The socket lives in a folder only this user can use, `<tmp>/porch-<uid>/`, named
 * after Pi's process id (`pi-<pid>.sock`); the path is recorded in the session
 * record, so the outside part never works it out. A path in PORCH_HOME could pass
 * the length limit of a socket path (104 bytes on macOS) for a deep scratch folder.
 */
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { SocketMissingError } from "../../unix-socket.js";

/** A request longer than this is refused by the extension, so a stray client cannot fill its memory. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

export type PiSocketStatus = "idle" | "busy" | "waiting-on-prompt";

export type PiReply = { ok: true; status: PiSocketStatus } | { ok: false; error: string };

export function requestLine(text: string): string {
  return JSON.stringify({ type: "deliver", text }) + "\n";
}

/** Parse one request line; null when it is not a deliver request. */
export function parseRequest(line: string): { text: string } | null {
  try {
    const v = JSON.parse(line) as { type?: unknown; text?: unknown };
    return v && v.type === "deliver" && typeof v.text === "string" ? { text: v.text } : null;
  } catch {
    return null;
  }
}

export function replyLine(reply: PiReply): string {
  return JSON.stringify(reply) + "\n";
}

function parseReply(line: string): PiReply {
  const v = JSON.parse(line) as { ok?: unknown; status?: unknown; error?: unknown };
  if (v?.ok === true && (v.status === "idle" || v.status === "busy" || v.status === "waiting-on-prompt")) return { ok: true, status: v.status };
  if (v?.ok === false) return { ok: false, error: typeof v.error === "string" ? v.error : "the session refused the message" };
  throw new Error(`unexpected reply from the Pi session: ${line.slice(0, 200)}`);
}

/**
 * Write one message to the Pi session's socket and wait for its reply. Rejects with
 * SocketMissingError when nothing listens there, and with an Error for anything
 * else (no reply in time, a reply that cannot be read).
 */
export function sendToPiSocket(address: string, text: string, timeoutMs = 5000): Promise<PiReply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const done = (err: Error | null, reply?: PiReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply!);
    };
    const socket = net.createConnection(address, () => {
      socket.write(requestLine(text));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try {
        done(null, parseReply(buffer.slice(0, nl)));
      } catch (err) {
        done(err as Error);
      }
    });
    socket.on("end", () => done(new Error(`the Pi session at ${address} closed the connection without replying`)));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") done(new SocketMissingError(`nothing is listening on ${address} (${err.code})`));
      else done(new Error(`could not write to ${address}: ${err.message}`));
    });
    const timer = setTimeout(() => done(new Error(`no reply from ${address} within ${timeoutMs} ms`)), timeoutMs);
  });
}

/** `<tmp>/porch-<uid>`: the folder the extension puts its sockets in. */
export function piSocketDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `porch-${uid}`);
}

export function piSocketPath(pid: number, dir = piSocketDir()): string {
  return path.join(dir, `pi-${pid}.sock`);
}

/**
 * Create the socket folder, or check the one that is there: a real folder (not a
 * symlink) owned by this user that no one else can write to. /tmp is shared on
 * Linux, so another user could have made the folder first to receive messages.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a folder`);
  if (uid !== null && st.uid !== uid) throw new Error(`${dir} belongs to another user (uid ${st.uid})`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${dir} can be written by other users (mode ${(st.mode & 0o777).toString(8)})`);
}

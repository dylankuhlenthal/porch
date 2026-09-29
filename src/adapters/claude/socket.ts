/**
 * Sending a message to a Claude Code session through its messaging socket.
 *
 * Claude Code documents the socket's path (CLAUDE_CODE_MESSAGING_SOCKET, visible
 * inside the session) but not the line written to it, which was observed (2.1.284)
 * as `{"type":"user","message":{"role":"user","content":"..."}}` followed by a
 * newline. The socket sends nothing back, so "sent" is all Porch can know. The
 * socket closes a connection that sends no complete line within 30 seconds, so a
 * connection is opened only once the text is ready. CLAUDE_CODE_MESSAGING_TOKEN is
 * never used (decision 10 in TRV-1133).
 */
import net from "node:net";
import path from "node:path";

export class SocketMissingError extends Error {}

/** The line Claude Code reads from its socket for one message. */
export function socketLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/** Write one message to the socket at `address`. Rejects with SocketMissingError when nothing listens there. */
export function sendToSocket(address: string, text: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const socket = net.createConnection(address, () => {
      socket.end(socketLine(text), () => done());
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        done(new SocketMissingError(`nothing is listening on ${address} (${err.code})`));
      } else {
        done(new Error(`could not write to ${address}: ${err.message}`));
      }
    });
    const timer = setTimeout(() => done(new Error(`timed out writing to ${address}`)), timeoutMs);
  });
}

/** Where Claude Code puts a session's socket when it is not recorded: /tmp/cc-socks/<pid>.sock, then /tmp/cc-socks-<uid>/<pid>.sock. */
export function guessedSocketPaths(pid: number, dirs: string[]): string[] {
  return dirs.map((d) => path.join(d, `${pid}.sock`));
}

export function defaultSocketDirs(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return ["/tmp/cc-socks", ...(uid === null ? [] : [`/tmp/cc-socks-${uid}`])];
}

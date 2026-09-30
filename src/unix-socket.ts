/**
 * Checks on a Unix socket path before an adapter's `deliver` connects to it. Shared
 * by the adapters that deliver through a socket (Claude Code, Pi). Part of sending,
 * so it is not read through `ctx.io` (the delivery exception in
 * docs/patterns/adapter-contract.md).
 */
import { promises as fs, type Stats } from "node:fs";

export class SocketMissingError extends Error {}
/** The path exists but is not a socket this user owns, so nothing is written to it. */
export class SocketRefusedError extends Error {}

/** How deliver looks at a socket path before connecting. Replaceable in tests. */
export interface SocketCheckOptions {
  /** Default: fs.lstat (a symlink is looked at, not followed). */
  lstat?: (file: string) => Promise<Pick<Stats, "uid" | "isSocket" | "isSymbolicLink">>;
  /** The user who must own the socket. Default: this process's uid; null skips the owner check (no uids on this platform). */
  uid?: number | null;
}

/**
 * Check that `address` is a socket owned by this user, and not a symlink, before
 * anything is written to it. /tmp is shared, so on a machine with other users
 * someone else could create a socket path (or its folder) first and receive the
 * message. Rejects with SocketMissingError when nothing is there, and
 * SocketRefusedError when something is there that Porch must not write to.
 */
export async function checkSocketOwner(address: string, options: SocketCheckOptions = {}): Promise<void> {
  const lstat = options.lstat ?? ((f: string) => fs.lstat(f));
  const uid = options.uid !== undefined ? options.uid : typeof process.getuid === "function" ? process.getuid() : null;
  let st: Pick<Stats, "uid" | "isSocket" | "isSymbolicLink">;
  try {
    st = await lstat(address);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new SocketMissingError(`nothing is listening on ${address} (${code})`);
    throw new SocketRefusedError(`could not check ${address}: ${(err as Error).message}`);
  }
  if (st.isSymbolicLink()) throw new SocketRefusedError(`refused ${address}: it is a symlink, not a socket`);
  if (!st.isSocket()) throw new SocketRefusedError(`refused ${address}: it is not a socket`);
  if (uid !== null && st.uid !== uid) throw new SocketRefusedError(`refused ${address}: the socket belongs to another user (uid ${st.uid})`);
}

# Session records

A session record is a small JSON file an adapter's inside part keeps up to date from within a running session, so Porch can read the session's state from outside. It exists because some harnesses (Pi) have no outside way into a running session at all, and others (Claude Code) only tell the session itself how to reach it; see decision 0001 (each adapter's inside part writes a per-session record).

Code: `src/records.ts` (`RecordStore`), `src/fsutil.ts` (lock and atomic write), `src/home.ts` (where the folder is). Format: `schemas/record.schema.json`.

## Where records live

`$PORCH_HOME/sessions/<harness>-<session>.json`, with `PORCH_HOME` defaulting to `~/.porch`. Harness names are lowercase letters and digits (no dash), so the first dash in a file name always separates harness from session. Session ids must start with a letter or digit and use only letters, digits, `.`, `_`, `:` and `-`, with no `..`; anything else is refused before a path is built, so an id from the environment cannot point outside the folder. Files are created with mode 0600 and the folder with 0700.

## What is in a record

- `schema` (1), `harness`, `session`, `createdAt`, `updatedAt`.
- `inside`: written only by the adapter's inside part, or null. Fields every adapter may use: `pid`, `status` and `since`, `delivery` (`{ via, address }`: how to reach the session, for example a socket path), `cwd`, `lastTurnStart`, `lastTurnEnd`, `backgroundTasks`. Anything else harness-specific goes in `data`.
- `self`: written only by `porch status set`, or null: `{ status, text, since }`.

A record may have only a `self` part: `porch status set` in a session whose harness has no inside part installed creates one.

## How writes work

Every write goes through `RecordStore`: `updateInside(harness, session, patch)` and `remove(harness, session)` for the inside part, `setSelf(...)` for `porch status set`. Each write:

1. takes `<file>.lock`, created exclusively and holding a token unique to this write, so only one process writes a record at a time. A lock older than 2 seconds whose writer's process has exited, or older than 30 seconds in any case, was left by a crashed writer and is broken (`withLock` in `src/fsutil.ts`);
2. reads the current record, or starts a new one;
3. changes only its own part;
4. writes the whole record to a temp file next to it and renames it over the old one, so readers never see a half-written file.

Because every writer changes only its own part under the lock, a hook recording a turn end and `porch status set` running at the same moment both land.

`updateInside` with a patch object merges it onto the current inside part (and `data` key by key); a key given as `undefined` is left out of the patch, never used to erase a value. With a function, the function gets the current inside part and returns the whole new one. Either way, when `status` changes and no `since` is given, `since` is set to now.

A record that exists but cannot be read (not JSON, or not a schema 1 record) is never overwritten: writes to it fail with `CorruptRecordError`. Records are only written by rename, so this happens only if something else edited the file.

Readers (`read`, `list`) take no lock. `list` skips `.lock` and `.tmp` files and reports a file it cannot parse, or whose name does not match its contents, as a problem instead of failing; `porch list` shows these problems in its `errors`.

## Who removes records

The inside part removes its record when the session ends cleanly (for example a session-end hook). A session that crashes leaves its record behind; the adapter's outside listing is what shows it as `gone`. Nothing sweeps old records yet.

# Session records

A session record is a small JSON file an adapter's inside part keeps up to date from within a running session, so Porch can read the session's state from outside. It exists because some harnesses (Pi) have no outside way into a running session at all, and others (Claude Code) only tell the session itself how to reach it; see decision 0001 (each adapter's inside part writes a per-session record).

Code: `src/records.ts` (`RecordStore`), `src/fsutil.ts` (lock and atomic write), `src/prune.ts` (removing the records of sessions that stopped), `src/home.ts` (where the folder is). Format: `schemas/record.schema.json`.

## Where records live

`$PORCH_HOME/sessions/<harness>-<session>.json`, with `PORCH_HOME` defaulting to `~/.porch`. Harness names are lowercase letters and digits (no dash), so the first dash in a file name always separates harness from session. Session ids must start with a letter or digit and use only letters, digits, `.`, `_`, `:` and `-`, with no `..`; anything else is refused before a path is built, so an id from the environment cannot point outside the folder. Files are created with mode 0600 and the folder with 0700.

## What is in a record

- `schema` (2; Porch also reads schema 1 records, from before sessions could end as `ended`, and writes them back as 2), `harness`, `session`, `createdAt`, `updatedAt`.
- `inside`: written only by the adapter's inside part, or null. Fields every adapter may use: `pid`, `status` and `since`, `delivery` (`{ via, address }`: how to reach the session, for example a socket path), `cwd`, `lastTurnStart`, `lastTurnEnd`, `backgroundTasks`, and, once the session has ended cleanly, `endedAt` and `endReason` (below). Anything else harness-specific goes in `data`.
- `self`: written only by `porch status set`, or null: `{ status, text, since }`.
- `goneSeenAt` (optional): when `porch list` or `porch watch` first saw the session gone, written only by them (below).

A record may have only a `self` part: `porch status set` in a session whose harness has no inside part installed creates one.

## How writes work

Every write goes through `RecordStore`: `updateInside(harness, session, patch)` and `updateInsideIfExists(harness, session, patch)` for the inside part, `setSelf(...)` for `porch status set`, and `markGoneSeen` and `removeIf` for `porch list` and `porch watch` (below). `updateInsideIfExists` does the same as `updateInside` when the record exists and its session has not ended, and writes nothing (returning null) otherwise; inside parts use it for every event except the session's start, so an event that arrives after the session ended (a late hook) neither brings back a record nor turns an ended session back into a running one. `updateInsideIfExistsSync` is the same, done synchronously, for a process that is exiting (the Pi extension's exit fallback, `docs/domains/pi-adapter.md`): a lock held by that same process belongs to a write that will never finish, so it takes it over; another process's lock it waits for at most half a second. Each write:

1. takes `<file>.lock`, created exclusively and holding a token unique to this write, so only one process writes a record at a time. A lock older than 2 seconds whose writer's process has exited, or older than 30 seconds in any case, was left by a crashed writer and is broken (`withLock` in `src/fsutil.ts`);
2. reads the current record, or starts a new one (`updateInsideIfExists` stops here when there is none);
3. changes only its own part;
4. writes the whole record to a temp file next to it and renames it over the old one, so readers never see a half-written file.

Because every writer changes only its own part under the lock, a hook recording a turn end and `porch status set` running at the same moment both land.

`updateInside` with a patch object merges it onto the current inside part (and `data` key by key); a key given as `undefined` is left out of the patch, never used to erase a value. With a function, the function gets the current inside part and returns the whole new one. Either way, when `status` changes and no `since` is given, `since` is set to now. `endedAt` and `endReason` are kept only while `status` is `ended`: a write that sets any other status (a resumed session's start) drops them. Every write except `markGoneSeen`'s drops `goneSeenAt`, since a record that is being written to belongs to a session that is not gone.

A record that exists but cannot be read (not JSON, or not a schema 1 or 2 record) is never overwritten: writes to it fail with `CorruptRecordError`. Records are only written by rename, so this happens only if something else edited the file.

Readers (`read`, `list`) take no lock. `list` skips `.lock` and `.tmp` files and reports a file it cannot parse, or whose name does not match its contents, as a problem instead of failing; `porch list` shows these problems in its `errors`.

## When a session stops, and who removes records

When a session ends cleanly, the inside part does not delete its record: it sets `status: "ended"`, `endedAt` (now) and `endReason` (why, as the harness said it, or null when the harness gave none; never a guess), through `updateInsideIfExists`. So `observe` still answers for the session, as `ended`, and a tool can tell how it stopped. A session that dies without its end hook (a crash, `kill -9`) leaves its record as it was; the adapter's outside view (Claude Code's listing, `ps` for Pi) shows it as `gone`. Decision 0013 (ended sessions keep their records for a day) records why.

Nothing else writes the inside part after that, except a new start: a Claude Code session resumed with the same id runs its `SessionStart` hook again, which makes the record a running one.

`porch list` and `porch watch` remove these records (`pruneStopped` in `src/prune.ts`), each time they read the records, from the observations their adapters returned:

- An `ended` record is removed 24 hours after its `endedAt`.
- The first look that sees a session `gone` writes `goneSeenAt` into its record (`markGoneSeen`), and the record is removed 24 hours after that. Only a `gone` status counts, which each adapter gives only once it has confirmed the process is not running (Pi: the pid and start-time rule; Claude Code: no pid in `claude agents --json`; `unknown` never counts). Counting from the first sighting rather than the last write means a session idle for days and then killed still keeps its record for a day.

Each record is read first without a lock, so a look with nothing to do takes none. A removal re-reads the record under its lock (`removeIf`) and removes it only if the reason still holds, so a session that started again in between keeps its record. Pruning is best effort: a failure is left for the next look, and a machine where nobody runs `list` or `watch` keeps its records. The 24 hours (`STOPPED_RECORD_TTL_MS`) are not configurable for now; making them so would mean a `PORCH_*` variable read by `pruneStopped`'s callers.

`remove(harness, session)` still exists but no adapter's inside part uses it.

# 0004: Porch writes self-reported state, with one writer per part of the record

**Date:** 2026-09-29
**Status:** Accepted

## Context
Sessions report their own state ("needs input", "blocked", "done") as well as what Porch observes. Either Porch only defines a schema that each tool (such as a consumer's own report command) writes into the record itself, or Porch writes it.

## Decision
`porch status set <working|needs-input|blocked|done|failed> [text]`, run inside the session, writes the self-reported part of that session's record. Porch works out which session is calling by asking each adapter's `current`. The inside part owns the record's `inside` part and `porch status set` owns its `self` part; nothing else writes either. Observations show the two side by side and never combine them.

## Consequences
Tools such as `sc report` call `porch status set` (with their own statuses mapped onto Porch's) instead of writing Porch's files. Because two writers share one file, every write takes a short lock and replaces the file atomically (`src/records.ts`). A process whose environment matches more than one harness's session is refused rather than guessed.

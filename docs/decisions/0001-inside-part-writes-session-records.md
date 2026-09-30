# 0001: Each adapter's inside part writes a per-session record, and the CLI reads the records

**Date:** 2026-09-29
**Status:** Accepted

## Context
Porch has to read a session's state and deliver to it from outside the session. Pi has no outside way into a running interactive session at all. Claude Code documents its delivery socket path only inside the session (`CLAUDE_CODE_MESSAGING_SOCKET`), and its outside listing (`claude agents --json`) has been seen reporting a session busy for 15 minutes after its turn ended. Reading only from outside, the original proposal, cannot work for Pi.

## Decision
Every adapter has an inside part (Claude Code hook commands, a Pi extension) that writes a record for its session into a shared folder: session id, pid, how to deliver, current status and since when, alongside the self-reported state. The CLI reads the records and checks them against the harness's own listing where one exists, so a crashed session whose record was left behind shows as gone. Delivery results report only what Porch can know (`delivered` with the status at sending, `not-running`, or `failed`), because Claude Code's socket sends nothing back.

## Consequences
Sessions get full status only when the inside part is installed; sessions without it still get delivery and a coarser status. Records need a format (`schemas/record.schema.json`), safe concurrent writes, and removal on clean exit. See `docs/domains/session-records.md`.

# 0005: Publishing to npm waits until the second harness passes the shared tests

**Date:** 2026-09-29
**Status:** Accepted

## Context
The package name `@dylankuhlenthal/porch` is chosen and the package could be published from the first build. The contract is only called stable after the second harness (Pi) passes the shared tests, and the repo stays private until then (decision 0003, its own repo, private until the second harness passes).

## Decision
Nothing is published to npm, and no npm token is created, until the end of the Pi adapter work, after the repo goes public. Until then the package is kept publishable: its name, the `porch` bin and the `files` list are set, and CI checks `npm pack --dry-run`.

## Consequences
Consumers install from GitHub in the meantime (`README.md`); installing from git builds the package through the `prepare` script. Publishing is the last step of the Pi adapter work.

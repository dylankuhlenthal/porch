# 0015: Going public and publishing to npm once the first consumer runs on Porch

**Date:** 2026-10-02
**Status:** Accepted
**Amends:** decision 0010 (going public and publishing to npm wait until the first two tools built on Porch run on it).

## Context
Decision 0010 held back going public and publishing until two tools built on Porch ran on it. The first one now does. The maintainer decided the second can move onto Porch after Porch is public and on npm, so it can depend on the published package rather than a GitHub tag. Before going public, the repo's files named the maintainer, the tools built on Porch and private ticket ids, which mean nothing to anyone else.

## Decision
Porch goes public and is published to npm now, with one tool running on it. Every file is cleaned of those names, and a per-PR test (`tests/owner-neutral.test.ts`) fails if one comes back. Decision records are never edited after merge, but they held the same names, so they were cleaned once, by hand, in the same change; this record is the one exception to that rule, and the test skips `docs/decisions/` afterwards. Commit messages and history are left as they are, because rewriting them would change every commit id, including the `v0.1.0` tag a consumer installs from.

## Consequences
The steps for going public and the first publish are in `docs/operations/releasing.md`. Only one tool has used the library when it is first published, so it stays below 1.0 (decision 0018) and may still change. The branch ruleset on `main` can now be enforced (`docs/operations/ci.md`).

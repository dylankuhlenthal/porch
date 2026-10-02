# 0017: Releases are published by a GitHub Actions workflow with npm trusted publishing

**Date:** 2026-10-02
**Status:** Accepted

## Context
Porch needs a way to publish to npm. The alternatives were publishing every release by hand from the maintainer's machine, which publishes whatever is in that checkout and attaches no provenance (npm's record of which commit and workflow built a package), or a workflow holding an npm token in the repo's secrets, which is a long-lived credential that can leak.

## Decision
Pushing a tag `v<version>` runs `.github/workflows/release.yml`, which publishes with npm trusted publishing: npm accepts the workflow's GitHub identity instead of a token, and attaches provenance. The workflow publishes nothing unless the tag matches `package.json`'s version, the tagged commit is on `main`, and the full CI gate passes. No npm token is ever created, and the package is set to require two-factor authentication and refuse tokens. npm sets up a trusted publisher only for a package that already exists, so the first version is published once by hand by the maintainer.

## Consequences
Every release after the first is built by CI from a tagged commit on `main`, with provenance. The workflow skips publishing a version already on npm, so the first version's tag passes. Renaming the workflow file means changing the trusted publisher on npm. The steps are in `docs/operations/releasing.md`.

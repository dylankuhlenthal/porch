# 0003: Porch lives in its own repo, private until the second harness passes the shared tests

**Date:** 2026-09-29
**Status:** Accepted

## Context
Porch has consumers in several repos and may take community contributions later. Its contract is only proven once a second harness passes the same tests. The alternatives were living inside its first consumer's repo, or going public from day one.

## Decision
Porch is its own repo, github.com/dylankuhlenthal/porch, private until the Pi adapter passes the shared conformance tests, then public.

## Consequences
While private, GitHub on the maintainer's plan refuses rulesets and branch protection, so the per-PR check runs but is not enforced as required; `docs/operations/ci.md` has the ruleset ready to apply when the repo goes public. Contributor-facing pieces (CONTRIBUTING, recorded fixtures for fork PRs) are built from the start.

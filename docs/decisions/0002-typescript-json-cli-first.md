# 0002: TypeScript on npm, a JSON CLI first with a thin library on top

**Date:** 2026-09-29
**Status:** Accepted

## Context
Porch's first consumer is written in Python; others are Node. The Pi adapter's inside part must be a Pi extension, which is TypeScript. The alternative was a Python standard-library package.

## Decision
Porch is one TypeScript npm package, `@dylankuhlenthal/porch`, holding the core, every adapter's inside and outside parts, and a `porch` command whose output is JSON. The library is a thin layer over the same code for Node consumers. Consumers in other languages call the command as a subprocess.

## Consequences
One language across the whole package. The JSON output is the contract, so it is versioned (`schema: 1`) with JSON Schema files, and exit codes are documented (`docs/reference/cli-output.md`). The first consumer gains a Node dependency, a deliberate change to its standard-library-only stack, recorded in that consumer's own repo.

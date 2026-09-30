# 0010: Going public and publishing to npm wait until sous chef and shape-gui run on Porch

**Date:** 2026-09-30
**Status:** Accepted
**Amends:** when decision 0003 (own repo, private until the second harness passes) and decision 0005 (npm publishing waits for the second harness) take effect; the rest of both stands.

## Context
Decisions 0003 and 0005 made the repo public, and the package published to npm, as soon as the Pi adapter passed the shared conformance tests, as the last step of the Pi adapter work. Before that work started, Dylan changed the order: Pi goes first, then sous chef moves onto Porch (TRV-1143), then shape-gui moves onto Porch (TRV-1145), and only then the repo goes public and Porch is published. In his words, "sc and shape gui are our testing grounds": the contract should be proven by its first two consumers, not only by two harnesses, before anyone outside can depend on it.

## Decision
The Pi adapter work neither makes the repo public nor publishes to npm, and creates no npm token. Both move to their own final issue, TRV-1146, after sous chef (TRV-1143) and shape-gui (TRV-1145) run on Porch. Until then the repo stays private and the package stays publishable but unpublished, as decision 0005 describes.

## Consequences
Consumers keep installing from GitHub (`README.md`). Required checks stay unenforced while the repo is private (`docs/operations/ci.md`). A breaking change found while moving sous chef and shape-gui onto Porch can still be made before anything outside depends on it.

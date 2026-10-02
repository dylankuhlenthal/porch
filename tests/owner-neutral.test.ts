// Porch is public, so its files name no particular person, private tool or private ticket.
// Fails if any tracked file matches one of the words below. Not checked:
// - docs/decisions/: decision records are never edited after merge; they were cleaned once,
//   by hand, before the repo went public (decision 0015).
// - package-lock.json: third-party package names (json-schema-traverse, for example).
// - binary files, and this file, which has to spell the words out.
// The maintainer's name is allowed as the author in package.json and the copyright holder
// in LICENSE; the GitHub account name (in the package scope and the repo URL) never
// matches, because the patterns need the name to end where the word ends.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO } from "./helpers.js";

const PATTERNS: RegExp[] = [
  /\bDylan\b/i,
  /\bdyl\//,
  /dylkuhl/i,
  /\bTRV-\d+/i,
  /\bTraverse\b|thetraverse/,
  /groundflr/i,
  /moodle/i,
  /sous[ -]?chef/i,
  /shape-gui/i,
];

const SKIPPED_DIRS = ["docs/decisions/"];
const SKIPPED_FILES = ["package-lock.json", "tests/owner-neutral.test.ts"];
const ALLOWED: Record<string, string[]> = {
  "package.json": ['"author": "Dylan Kuhlenthal"'],
  LICENSE: ["Copyright (c) 2026 Dylan Kuhlenthal"],
};

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  return out.split("\0").filter((f) => f !== "" && !SKIPPED_FILES.includes(f) && !SKIPPED_DIRS.some((d) => f.startsWith(d)));
}

describe("owner-neutral files", () => {
  it("no tracked file outside docs/decisions/ names the maintainer, a private tool or a private ticket", () => {
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      const bytes = readFileSync(path.join(REPO, file));
      if (bytes.includes(0)) continue;
      let text = bytes.toString("utf8");
      for (const allowed of ALLOWED[file] ?? []) text = text.split(allowed).join("");
      text.split("\n").forEach((line, i) => {
        const pattern = PATTERNS.find((p) => p.test(line));
        if (pattern) hits.push(`${file}:${i + 1}: ${pattern.source}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

// The supported library is exactly what docs/reference/library.md lists: the names in its
// main-import and `/testing` tables must be the names dist/index.d.ts and dist/testing.d.ts
// export, values and types alike. Reads the built .d.ts files (npm test builds first), so
// it checks what the package ships.
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { REPO } from "./helpers.js";

const DOC = readFileSync(path.join(REPO, "docs", "reference", "library.md"), "utf8");

/** The first-column names of the table under the `## <heading>` section. */
function documentedNames(heading: string): string[] {
  const start = DOC.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`docs/reference/library.md has no section "## ${heading}"`);
  const next = DOC.indexOf("\n## ", start + 1);
  const section = DOC.slice(start, next < 0 ? undefined : next);
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\| `([^`]+)` \|/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names.sort();
}

/** Every name a built entry file exports, values and types. */
function exportedNames(entry: string): string[] {
  const file = path.join(REPO, "dist", entry);
  const program = ts.createProgram([file], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`${file} not found; npm test builds before running the tests`);
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`${file} is not a module`);
  return checker.getExportsOfModule(symbol).map((s) => s.getName()).sort();
}

describe("the supported library matches docs/reference/library.md", () => {
  it("the main import exports exactly the documented names", () => {
    expect(exportedNames("index.d.ts")).toEqual(documentedNames("`@dylankuhlenthal/porch`"));
  });

  it("/testing exports exactly the documented names", () => {
    expect(exportedNames("testing.d.ts")).toEqual(documentedNames("`@dylankuhlenthal/porch/testing`"));
  });

  it("every import path in package.json is in the import paths table, and no other", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    const fromPackage = Object.keys(pkg.exports)
      .filter((key) => key !== "./package.json")
      .map((key) => (key === "." ? "@dylankuhlenthal/porch" : `@dylankuhlenthal/porch/${key.slice(2)}`))
      .sort();
    expect(documentedNames("Import paths")).toEqual(fromPackage);
  });
});

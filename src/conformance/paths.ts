/**
 * Where conformance output lives in the repo:
 *   conformance/fixtures/<harness>/<case>.json   what the harness returned, replayed by the per-PR tests
 *   conformance/reports/<harness>.json           the last run's report (harness version, results)
 * Both are committed with any PR that adds or changes an adapter (CONTRIBUTING.md).
 */
import path from "node:path";

export const FIXTURES_DIR = path.join("conformance", "fixtures");
export const REPORTS_DIR = path.join("conformance", "reports");

export function fixturePath(root: string, harness: string, caseName: string): string {
  return path.join(root, FIXTURES_DIR, harness, `${caseName}.json`);
}

export function reportPath(root: string, harness: string): string {
  return path.join(root, REPORTS_DIR, `${harness}.json`);
}

import type { Hunk } from "../../diff/index.js";
import type { Warning } from "./index.js";
import { globToRegExp } from "./risk-rules.js";

// Tests deleted or weakened (DB-11). Line-based, best effort: a hunk doesn't
// show where one test ends, so "assertions removed" is counted per hunk.

const TEST_FILES = [
  "**/*.{test,spec}.*",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
  "**/__tests__/**",
].map(globToRegExp);
const SNAPSHOTS = ["**/__snapshots__/**", "**/*.snap"].map(globToRegExp);

// The name a test is declared with: it("name", …), def test_name, func TestName.
const TEST_DECL = [
  /^\s*(?:it|test|describe)(?:\.each\([^)]*\))?\s*\(\s*(["'`])(.+?)\1/,
  /^\s*(?:async\s+)?def\s+(test_\w+)/,
  /^\s*func\s+(Test\w+)\s*\(/,
];
// Anchored to the start of the statement, so a test that mentions it.skip in
// a string (a fixture, a rule like this one) isn't read as skipping.
const SKIPPED =
  /^\s*(?:(?:it|test|describe)\.(?:skip|todo)\b|x(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|t\.Skip(?:Now|f)?\(|@unittest\.skip|@Disabled\b|@Ignore\b)/;
// Focusing one test silently skips the rest of the suite.
const FOCUSED = /^\s*(?:(?:it|test|describe)\.only\b|f(?:it|describe)\s*\()/;
const ASSERTION =
  /\b(?:expect|assert\w*|should)\s*[.(]|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\b|\bself\.assert\w*\(/;

export const isTestFile = (path: string) => TEST_FILES.some((re) => re.test(path));

export function testWarnings(hunks: Hunk[]): Warning[] {
  const warnings: Warning[] = [];
  const added = (h: Hunk) => h.lines.filter((l) => l.kind === "+").map((l) => l.text);
  const removed = (h: Hunk) => h.lines.filter((l) => l.kind === "-").map((l) => l.text);

  // A test removed in one place and declared again anywhere (moved, renamed
  // file) isn't deleted.
  const readded = new Set(
    hunks.filter((h) => isTestFile(h.path)).flatMap((h) => added(h).flatMap(testName)),
  );

  const deletedFiles = new Set<string>();
  for (const h of hunks) {
    if (h.status === "deleted" && isTestFile(h.path) && !deletedFiles.has(h.path)) {
      deletedFiles.add(h.path);
      const ids = hunks.filter((x) => x.path === h.path).map((x) => x.id);
      warnings.push(rule("deleted_test", ids, `${h.path}: test file deleted`));
    }
  }

  for (const h of hunks) {
    if (SNAPSHOTS.some((re) => re.test(h.path))) {
      if (h.status === "modified")
        warnings.push(rule("weakened_test", [h.id], `${h.path}: snapshot updated`));
      continue;
    }
    if (!isTestFile(h.path) || deletedFiles.has(h.path)) continue;

    const gone = removed(h)
      .flatMap(testName)
      .filter((n) => !readded.has(n));
    if (gone.length) {
      warnings.push(rule("deleted_test", [h.id], `${h.path}: removed ${list(gone)}`));
    }
    const skipped = added(h).filter((t) => SKIPPED.test(t));
    if (skipped.length) {
      warnings.push(rule("weakened_test", [h.id], `${h.path}: skipped ${skipped.length} test(s)`));
    }
    if (added(h).some((t) => FOCUSED.test(t))) {
      warnings.push(rule("weakened_test", [h.id], `${h.path}: .only added, other tests won't run`));
    }
    const lost = removed(h).filter((t) => ASSERTION.test(t)).length;
    const gained = added(h).filter((t) => ASSERTION.test(t)).length;
    if (lost > gained) {
      warnings.push(
        rule("weakened_test", [h.id], `${h.path}: ${lost} assertion(s) removed, ${gained} added`),
      );
    }
  }
  return warnings;
}

function testName(line: string): string[] {
  for (const re of TEST_DECL) {
    const m = re.exec(line);
    if (m) return [m[m.length - 1]!];
  }
  return [];
}

function list(names: string[]): string {
  const shown = names
    .slice(0, 3)
    .map((n) => `"${n}"`)
    .join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

function rule(kind: Warning["kind"], hunks: string[], detail: string): Warning {
  return { kind, hunks, detail, source: "rules" };
}

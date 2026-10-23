import { posix } from "node:path";
import type { Hunk } from "../../diff/index.js";
import type { Warning } from "./index.js";
import { isTestFile } from "./test-rules.js";

// Code that changed with no test going with it. Whether a test goes with a
// file is a heuristic: the names match (order.js and order.test.js,
// test_order.py, order_test.go), the test imports it, or for Go it sits in
// the same package directory. It says nothing about which lines a test runs;
// that takes a coverage tool (DB-22).

export type RepoTest = { path: string; content: string };

export type TestGaps = {
  warnings: Warning[];
  // Changed code files no test file uses at all, in the diff or not.
  untested: Set<string>;
};

const CODE =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|ex|exs|c|cc|cpp|h|hpp|m|mm|dart|lua|clj)$/;
// Helpers and fixtures beside the tests aren't code that needs its own test.
const TEST_SIDE = /(?:^|\/)(?:tests?|spec|specs|__tests__|__mocks__|testdata|fixtures?|e2e)\//;

export const isTestSide = (path: string) => isTestFile(path) || TEST_SIDE.test(path);

// tests: the repo's test files on the final side of the diff. ranTests:
// a test command ran in the recorded sessions, so tests exist even where no
// file looks like one (Rust's inline test modules). read: any file's final
// content, to follow an import one hop (a test importing a barrel that
// re-exports the changed file).
export function testGaps(
  hunks: Hunk[],
  tests: RepoTest[],
  ranTests: boolean,
  read: (path: string) => string | null = () => null,
): TestGaps {
  const code = new Map<string, string[]>();
  for (const h of hunks) {
    if (h.status === "deleted" || !CODE.test(h.path) || isTestSide(h.path)) continue;
    code.set(h.path, [...(code.get(h.path) ?? []), h.id]);
  }
  if (code.size === 0) return { warnings: [], untested: new Set() };

  if (tests.length === 0) {
    if (ranTests) return { warnings: [], untested: new Set() }; // can't tell which
    return {
      warnings: [
        {
          kind: "no_tests",
          hunks: [...code.values()].flat(),
          detail: "This repo has no tests, so none of these changes were checked by one.",
          source: "rules",
        },
      ],
      untested: new Set(code.keys()),
    };
  }

  const changedTests = new Set(hunks.filter((h) => isTestFile(h.path)).map((h) => h.path));
  const warnings: Warning[] = [];
  const untested = new Set<string>();
  for (const [path, ids] of code) {
    const users = tests.filter((t) => uses(t, path, read));
    if (users.some((t) => changedTests.has(t.path))) continue;
    if (users.length === 0) untested.add(path);
    warnings.push({
      kind: "untested_change",
      hunks: ids,
      detail:
        users.length === 0
          ? `${path}: no test added or changed, and no test file uses it`
          : `${path}: no test added or changed (${list(users.map((t) => t.path))} ${users.length === 1 ? "uses it but wasn't" : "use it but weren't"} touched)`,
      source: "rules",
    });
  }
  return { warnings, untested };
}

// Names that say nothing about what's in the file; these match by import only.
const GENERIC = new Set(["index", "mod", "__init__", "main", "lib", "utils", "util", "types"]);

function uses(test: RepoTest, source: string, read: (path: string) => string | null): boolean {
  const name = stem(source);
  if (!GENERIC.has(name) && stem(test.path) === name) return true;
  if (source.endsWith(".go") && test.path.endsWith("_test.go")) {
    return posix.dirname(test.path) === posix.dirname(source);
  }
  const target = withoutExt(source);
  const direct = specifiers(test.content);
  if (direct.some((spec) => names(spec, posix.dirname(test.path), target))) return true;
  // One hop through the modules the test imports by relative path.
  return direct.some((spec) => {
    if (!spec.startsWith(".")) return false;
    const file = resolveFile(posix.join(posix.dirname(test.path), spec), read);
    const content = file && read(file);
    return !!content && specifiers(content).some((s) => names(s, posix.dirname(file), target));
  });
}

// Whether an import specifier, seen from a file in dir, names target (a path
// without extension).
export function names(spec: string, dir: string, target: string): boolean {
  if (spec.startsWith(".")) {
    const resolved = withoutExt(posix.normalize(posix.join(dir, spec)));
    // A directory import reaches its index file.
    return resolved === target || `${resolved}/index` === target;
  }
  // Package-style: python dotted modules, path aliases, crate paths.
  const asPath = spec.includes("/") ? withoutExt(spec) : spec.replace(/\./g, "/");
  return target === asPath || target.endsWith(`/${asPath}`);
}

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

// The file an import path points at: as written, with its extension swapped
// (TS imports .js for .ts), with one added, or a directory's index.
function resolveFile(path: string, read: (path: string) => string | null): string | undefined {
  const p = posix.normalize(path);
  const bare = withoutExt(p);
  const candidates = [p, ...EXTS.map((e) => bare + e), ...EXTS.map((e) => `${p}/index${e}`)];
  return candidates.find((c) => read(c) !== null);
}

// Module specifiers in import, require, from ... import, and use lines.
export function specifiers(content: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g, // JS/TS
    /^\s*from\s+([\w.]+)\s+import\b/gm, // python
    /^\s*import\s+([\w.]+)/gm, // python, java, kotlin, scala
    /^\s*use\s+(?:crate::)?([\w:]+)/gm, // rust
  ];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) out.push(m[1]!.replace(/::/g, "/"));
  }
  return out;
}

// order.test.js, order.spec.ts, test_order.py, order_test.go, OrderTest.java → order
function stem(path: string): string {
  return posix
    .basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/(?:[._-](?:test|spec)s?|Tests?)$/, "")
    .replace(/^test_/, "")
    .toLowerCase();
}

export function withoutExt(path: string): string {
  return path.replace(/\.[^./]+$/, "");
}

function list(paths: string[]): string {
  return paths.length > 2
    ? `${paths.slice(0, 2).join(", ")} and ${paths.length - 2} more`
    : paths.join(", ");
}

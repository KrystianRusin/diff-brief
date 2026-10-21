import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyTree, hasRev, type DiffSpec } from "./git.js";

// File contents at the two ends of a diff spec, for mapping (DB-08). null
// means the file doesn't exist on that side.
export type TargetContents = {
  base(path: string): Buffer | null;
  final(path: string): Buffer | null;
};

export function targetContents(root: string, spec: DiffSpec): TargetContents {
  const at = (rev: string) => cached((path) => show(root, rev, path));
  switch (spec.kind) {
    case "worktree":
      return { base: at(spec.base), final: cached((path) => readOrNull(join(root, path))) };
    case "commit": {
      const parent = hasRev(root, `${spec.sha}^`) ? `${spec.sha}^` : emptyTree(root);
      return { base: at(parent), final: at(spec.sha) };
    }
    case "range":
      return { base: at(spec.base), final: at(spec.head) };
  }
}

function cached(get: (path: string) => Buffer | null): (path: string) => Buffer | null {
  const memo = new Map<string, Buffer | null>();
  return (path) => {
    if (!memo.has(path)) memo.set(path, get(path));
    return memo.get(path)!;
  };
}

function show(root: string, rev: string, path: string): Buffer | null {
  try {
    return execFileSync("git", ["cat-file", "blob", `${rev}:${path}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

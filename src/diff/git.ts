import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What to diff. DB-09 resolves CLI flags and default bases into one of these.
export type DiffSpec =
  | { kind: "worktree"; base: string } // base..working tree, untracked files included
  | { kind: "commit"; sha: string } // sha^..sha, or empty tree..sha for a root commit
  | { kind: "range"; base: string; head: string }; // base..head

export class DiffError extends Error {}

// Config overrides so the user's git config can't change the output we
// parse or the hunks we hash.
const CONFIG = [
  "-c",
  "core.quotepath=off",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.suppressBlankEmpty=false",
];

// Hunk boundaries feed hunk ids, so everything that moves them is pinned.
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--full-index",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "--inter-hunk-context=0",
  "--submodule=short",
  "-O/dev/null",
  "-M",
  "-U3",
];

const MAX_BUFFER = 1024 * 1024 * 1024;

function git(root: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  try {
    return execFileSync("git", [...CONFIG, ...args], {
      cwd: root,
      env: opts.env,
      input: opts.input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new DiffError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function assertRev(rev: string): void {
  if (rev === "" || rev.startsWith("-")) throw new DiffError(`invalid revision: ${rev}`);
}

export function hasRev(root: string, rev: string): boolean {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", rev]);
    return true;
  } catch {
    return false;
  }
}

// The empty tree's id depends on the repo's hash algorithm (sha1 or sha256).
export function emptyTree(root: string): string {
  return git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).toString().trim();
}

// Raw `git diff` output for a spec.
export function runDiff(root: string, spec: DiffSpec): string {
  switch (spec.kind) {
    case "worktree":
      assertRev(spec.base);
      return worktreeDiff(root, spec.base);
    case "commit": {
      assertRev(spec.sha);
      const parent = hasRev(root, `${spec.sha}^`) ? `${spec.sha}^` : emptyTree(root);
      return git(root, ["diff", ...DIFF_FLAGS, parent, spec.sha, "--"]).toString();
    }
    case "range":
      assertRev(spec.base);
      assertRev(spec.head);
      return git(root, ["diff", ...DIFF_FLAGS, spec.base, spec.head, "--"]).toString();
  }
}

// Tracked changes plus untracked files, staged into a throwaway index so the
// user's real index is never touched. Starting from a copy of the real index
// keeps git's stat cache, so `add -A` only rehashes files that changed; if
// that fails (an index format the copy breaks), start over from HEAD's tree.
function worktreeDiff(root: string, base: string): string {
  const dir = mkdtempSync(join(tmpdir(), "diffbrief-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const realIndex = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
    .toString()
    .trim();
  try {
    try {
      copyFileSync(realIndex, env.GIT_INDEX_FILE);
      git(root, ["add", "-A", "--ignore-errors"], { env });
    } catch {
      rmSync(env.GIT_INDEX_FILE, { force: true });
      // No HEAD (no commits yet) means an empty starting index.
      if (hasRev(root, "HEAD")) git(root, ["read-tree", "HEAD"], { env });
      git(root, ["add", "-A", "--ignore-errors"], { env });
    }
    return git(root, ["diff", "--cached", ...DIFF_FLAGS, base, "--"], { env }).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

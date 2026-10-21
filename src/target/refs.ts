import { execFileSync } from "node:child_process";

// Ref and commit lookups for resolving diff targets. Each returns undefined
// (or false) instead of throwing when git has no answer.

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function resolveCommit(root: string, rev: string): string | undefined {
  if (rev === "" || rev.startsWith("-")) return undefined;
  return git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) || undefined;
}

export function parentOf(root: string, sha: string): string | undefined {
  return resolveCommit(root, `${sha}^`);
}

export function currentBranch(root: string): string | undefined {
  return git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"]) || undefined;
}

export function mergeBase(root: string, a: string, b: string): string | undefined {
  return git(root, ["merge-base", a, b]) || undefined;
}

// a is an ancestor of b, or the same commit.
export function isAncestor(root: string, a: string, b: string): boolean {
  return git(root, ["merge-base", "--is-ancestor", a, b]) !== undefined;
}

// Committer time in ms.
export function commitTime(root: string, sha: string): number | undefined {
  // ^{commit} so the empty tree (a root commit's base) has no time.
  const s = git(root, ["show", "--no-patch", "--format=%ct", `${sha}^{commit}`]);
  return s && /^\d+$/.test(s) ? Number(s) * 1000 : undefined;
}

// The branch work merges into: origin/HEAD's target, else a local main or
// master. `name` is the bare branch name, `rev` what to pass to git.
export function defaultBranch(root: string): { name: string; rev: string } | undefined {
  const remote = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remote?.startsWith("refs/remotes/origin/")) {
    const name = remote.slice("refs/remotes/origin/".length);
    return { name, rev: `origin/${name}` };
  }
  for (const name of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) {
      return { name, rev: name };
    }
  }
  return undefined;
}

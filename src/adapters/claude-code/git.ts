import { dirname, join } from "node:path";
import { childProcess, fs } from "../../store/builtins.js";

// Git calls the capture hook needs. Each spawns git, so callers use them only
// on rare events (session start/end, first touch of a file).

function git(root: string, args: string[], input?: Buffer): Buffer {
  return childProcess().execFileSync("git", args, {
    cwd: root,
    input,
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

// Walks up looking for .git instead of spawning `git rev-parse`, since this
// runs on every hook call. A .git file (worktree, submodule) counts too.
export function findGitRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function headSha(root: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).toString().trim() || null;
  } catch {
    return null;
  }
}

export function currentBranch(root: string): string | undefined {
  try {
    return git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).toString().trim() || undefined;
  } catch {
    return undefined; // detached HEAD
  }
}

// Repo-relative paths that differ from HEAD, including untracked files.
export function dirtyPaths(root: string): string[] {
  try {
    const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString();
    const paths: string[] = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      paths.push(entry.slice(3));
      // Renames and copies are followed by the source path as its own entry.
      if (entry[0] === "R" || entry[0] === "C") i++;
    }
    return paths;
  } catch {
    return [];
  }
}

// File contents at HEAD, one `git cat-file --batch` call for all paths.
// null = not in HEAD.
export function headContents(root: string, paths: string[]): Map<string, Buffer | null> {
  const result = new Map<string, Buffer | null>();
  if (paths.length === 0) return result;
  let out: Buffer;
  try {
    out = git(root, ["cat-file", "--batch"], Buffer.from(paths.map((p) => `HEAD:${p}\n`).join("")));
  } catch {
    for (const p of paths) result.set(p, null);
    return result;
  }
  let pos = 0;
  for (const p of paths) {
    const eol = out.indexOf(10, pos);
    if (eol === -1) break;
    const header = out.subarray(pos, eol).toString();
    pos = eol + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) {
      result.set(p, null); // "<object> missing"
      continue;
    }
    const size = Number(m[2]);
    result.set(p, m[1] === "blob" ? out.subarray(pos, pos + size) : null);
    pos += size + 1;
  }
  return result;
}

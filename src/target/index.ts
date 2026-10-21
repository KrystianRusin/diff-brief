import { createHash } from "node:crypto";
import { emptyTree, type DiffSpec } from "../diff/git.js";
import type { DiffTarget } from "../schema/annotations.js";
import type { SessionSummary } from "../store/read.js";
import {
  commitTime,
  currentBranch,
  defaultBranch,
  isAncestor,
  mergeBase,
  parentOf,
  resolveCommit,
} from "./refs.js";

export { gatherSessions, mergeSessions, selectSessions } from "./sessions.js";
export type { MergedEvent, SessionContext, SessionEvents } from "./sessions.js";

// A briefing is about a diff, not a session (DB-09). These turn what the user
// asked for into a resolved target: full shas, the briefing id, and what
// session selection and mapping need to know about it.

// CLI: --worktree [base], --commit <sha>, --range <a>..<b>; nothing = worktree.
export type TargetRequest = {
  worktree?: string | true;
  commit?: string;
  range?: string;
};

export type ResolvedTarget = {
  target: DiffTarget;
  spec: DiffSpec;
  briefingId: string;
  // Committer times (ms) of the base and head commits; head is absent for
  // the worktree, base for the empty tree.
  baseTime?: number;
  headTime?: number;
  // Branch checked out when a worktree target was resolved.
  branch?: string;
};

export class TargetError extends Error {}

export function resolveTarget(
  root: string,
  req: TargetRequest,
  sessions: SessionSummary[] = [],
): ResolvedTarget {
  const given = [req.worktree !== undefined, req.commit !== undefined, req.range !== undefined];
  if (given.filter(Boolean).length > 1) {
    throw new TargetError("pass only one of --worktree, --commit, --range");
  }

  if (req.commit !== undefined) {
    const head = mustResolve(root, req.commit);
    const base = parentOf(root, head) ?? emptyTree(root);
    return finish(root, { kind: "commit", base, head }, { kind: "commit", sha: head });
  }

  if (req.range !== undefined) {
    // a...b means from where b forked off a, like git diff.
    const m = /^(.+?)(\.\.\.?)(.+)$/.exec(req.range);
    if (!m) throw new TargetError(`--range expects <a>..<b>, got ${req.range}`);
    const a = mustResolve(root, m[1]!);
    const head = mustResolve(root, m[3]!);
    const base = m[2] === "..." ? mergeBase(root, a, head) : a;
    if (!base) throw new TargetError(`${m[1]} and ${m[3]} have no common ancestor`);
    return finish(root, { kind: "range", base, head }, { kind: "range", base, head });
  }

  const branch = currentBranch(root);
  const base =
    typeof req.worktree === "string"
      ? mustResolve(root, req.worktree)
      : defaultWorktreeBase(root, branch, sessions);
  return {
    ...finish(root, { kind: "worktree", base, head: "WORKTREE" }, { kind: "worktree", base }),
    ...(branch ? { branch } : {}),
  };
}

// 1. On a feature branch with sessions: the oldest session base still behind
//    HEAD, so a ticket spread over several sessions and commits is one diff.
//    Never older than the fork point from the default branch.
// 2. On the default branch: HEAD. Sessions there belong to whatever was
//    committed in between, so the briefing is the uncommitted work; commits
//    are briefed with --commit.
// 3. Otherwise the fork point from the default branch, or HEAD.
export function defaultWorktreeBase(
  root: string,
  branch: string | undefined,
  sessions: SessionSummary[],
): string {
  const head = resolveCommit(root, "HEAD");
  if (!head) return emptyTree(root); // no commits yet
  const def = defaultBranch(root);
  if (branch && def && branch === def.name) return head;

  const forkPoint = def ? mergeBase(root, head, def.rev) : undefined;
  if (branch) {
    const bases = sessions
      .filter((s) => s.branch === branch && s.baseSha)
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
      .map((s) => resolveCommit(root, s.baseSha!))
      .filter((sha): sha is string => !!sha && isAncestor(root, sha, head));
    const oldest = bases[0];
    if (oldest) {
      return forkPoint && oldest !== forkPoint && isAncestor(root, oldest, forkPoint)
        ? forkPoint
        : oldest;
    }
  }
  return forkPoint ?? head;
}

function finish(root: string, target: DiffTarget, spec: DiffSpec): ResolvedTarget {
  const baseTime = commitTime(root, target.base);
  const headTime = target.head === "WORKTREE" ? undefined : commitTime(root, target.head);
  return {
    target,
    spec,
    briefingId: briefingId(target),
    ...(baseTime !== undefined ? { baseTime } : {}),
    ...(headTime !== undefined ? { headTime } : {}),
  };
}

// Worktree briefings for the same base reuse one id, so they're updated in
// place as the tree changes.
export function briefingId(target: DiffTarget): string {
  return createHash("sha256")
    .update(target.kind + target.base + target.head)
    .digest("hex")
    .slice(0, 12);
}

function mustResolve(root: string, rev: string): string {
  const sha = resolveCommit(root, rev);
  if (!sha) throw new TargetError(`unknown revision: ${rev}`);
  return sha;
}

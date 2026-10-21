import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadBriefingInputs } from "../../src/briefing/inputs.js";
import { emptyTree } from "../../src/diff/index.js";
import type { Event } from "../../src/schema/events.js";
import { putBlob } from "../../src/store/blobs.js";
import { listSessions } from "../../src/store/read.js";
import { appendEvent } from "../../src/store/sessions.js";
import {
  briefingId,
  mergeSessions,
  resolveTarget,
  TargetError,
  type TargetRequest,
} from "../../src/target/index.js";
import { makeTempRepo, type TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  repo = makeTempRepo();
});
afterEach(() => {
  repo.cleanup();
  vi.unstubAllEnvs();
});

const T0 = Date.parse("2026-10-01T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const lines = (n: number, label = "line") =>
  Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

// Writes a session into .diffbrief/ the way the DB-05 adapter does: edits
// with stored snapshots, intents as narration, and the files changed on disk.
function session(id: string, startMin: number) {
  const root = repo.dir;
  const branch = repo.git("symbolic-ref", "--short", "-q", "HEAD");
  let n = 0;
  const emit = (e: Event) => appendEvent(root, id, e);
  emit({
    v: 1,
    type: "session_start",
    ts: at(startMin).toISOString(),
    agent: "claude-code",
    session_id: id,
    base_sha: repo.git("rev-parse", "HEAD"),
    ...(branch ? { branch } : {}),
    cwd: root,
  });
  const read = (path: string) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
  return {
    // Edit `path` with `change` at minute `min`, explained by `why`.
    edit(min: number, path: string, change: (s: string) => string, why: string) {
      const ts = at(min).toISOString();
      const before = read(path);
      const after = change(before ?? "");
      const intent = `i${++n}`;
      emit({ v: 1, type: "intent", ts, id: intent, why, source: "narration" });
      emit({
        v: 1,
        type: "edit",
        ts,
        id: `${id}-e${n}`,
        path,
        tool: "Edit",
        before_hash: before === null ? null : putBlob(root, before),
        after_hash: putBlob(root, after),
        intent_id: intent,
      });
      repo.write(path, after);
    },
  };
}

function brief(req: TargetRequest = {}) {
  const inputs = loadBriefingInputs(repo.dir, req);
  const why = new Map(
    inputs.events.flatMap((e) => (e.type === "intent" ? [[e.id, e.why] as const] : [])),
  );
  const rows = inputs.hunks.map((h) => {
    const m = inputs.mapping.byHunk[h.id]!;
    return [h.path, m.intentId ? why.get(m.intentId) : m.serves];
  });
  return { ...inputs, rows };
}

describe("multi-session briefings", () => {
  test("two sessions on a branch with a commit in between give one briefing", () => {
    repo.write("a.ts", lines(30));
    repo.write("b.ts", lines(30));
    const base = repo.commit("base", at(0));
    repo.git("checkout", "--quiet", "-b", "feature/DB-42");

    const a = session("aaaaaaaa-1", 5);
    a.edit(10, "a.ts", (s) => s.replace("line 10\n", "ten\n"), "fix a");
    repo.commit("session A's work", at(20));

    const b = session("bbbbbbbb-2", 30);
    b.edit(35, "b.ts", (s) => s.replace("line 10\n", "ten\n"), "fix b");
    b.edit(36, "a.ts", (s) => s.replace("line 25\n", "twenty-five\n"), "follow-up in a");

    const r = brief();
    expect(r.resolved.target).toEqual({ kind: "worktree", base, head: "WORKTREE" });
    expect(r.sessionIds).toEqual(["aaaaaaaa-1", "bbbbbbbb-2"]);
    expect(r.rows).toEqual([
      ["a.ts", "fix a"],
      ["a.ts", "follow-up in a"],
      ["b.ts", "fix b"],
    ]);
    // Ids are namespaced by session.
    expect(Object.values(r.mapping.byHunk).map((m) => m.intentId)).toEqual([
      "aaaaaaaa:i1",
      "bbbbbbbb:i2",
      "bbbbbbbb:i1",
    ]);
    expect(r.context.map((c) => c.sessionId)).toEqual(["aaaaaaaa-1", "bbbbbbbb-2"]);
    expect(r.context[0]).toMatchObject({ branch: "feature/DB-42" });
  });

  test("--commit on a commit made during a session briefs only that commit", () => {
    repo.write("a.ts", lines(30));
    repo.write("b.ts", lines(30));
    repo.commit("base", at(0));

    const s = session("cccccccc-3", 5);
    s.edit(10, "a.ts", (x) => x.replace("line 10\n", "ten\n"), "fix a");
    const sha = repo.commit("a only", at(15));
    s.edit(40, "b.ts", (x) => x.replace("line 10\n", "ten\n"), "fix b, uncommitted");

    const r = brief({ commit: sha });
    expect(r.resolved.target.kind).toBe("commit");
    expect(r.rows).toEqual([["a.ts", "fix a"]]);
    expect(r.mapping.deadEnds).toEqual([]);
  });

  test("on the default branch the worktree briefing is the uncommitted work", () => {
    repo.write("a.ts", lines(30));
    repo.commit("base", at(0));

    // One long session spanning a commit, like working ticket by ticket.
    const s = session("dddddddd-4", 5);
    s.edit(10, "a.ts", (x) => x.replace("line 10\n", "ten\n"), "ticket 1");
    s.edit(11, "b.ts", () => "uncommitted from ticket 1\n", "ticket 1 leftover");
    repo.git("add", "a.ts");
    repo.git("commit", "--quiet", "-m", "ticket 1");
    const head = repo.git("rev-parse", "HEAD");
    // Committed "now"; ticket 2's edits come after it.
    const after = (Date.now() - T0) / 60_000 + 1;
    s.edit(after, "a.ts", (x) => x.replace("ten\n", ""), "ticket 2 drops the line ticket 1 added");
    s.edit(after + 1, "a.ts", (x) => x.replace("line 20\n", "twenty\n"), "ticket 2");

    const r = brief();
    expect(r.resolved.target.base).toBe(head);
    expect(r.rows).toEqual([
      ["a.ts", "ticket 2 drops the line ticket 1 added"],
      ["a.ts", "ticket 2"],
      ["b.ts", "ticket 1 leftover"],
    ]);
    // Ticket 1's committed edit isn't replayed as a dead end.
    expect(r.mapping.deadEnds).toEqual([]);
  });

  test("a session on another branch touching the same file is left out", () => {
    repo.write("a.ts", lines(30));
    repo.commit("base", at(0));
    repo.git("checkout", "--quiet", "-b", "other");
    const other = session("eeeeeeee-5", 5);
    other.edit(10, "a.ts", (x) => x.replace("line 5\n", "five\n"), "other branch");
    repo.git("stash", "--quiet");
    repo.git("checkout", "--quiet", "-b", "mine", "main");
    const mine = session("ffffffff-6", 20);
    mine.edit(25, "a.ts", (x) => x.replace("line 10\n", "ten\n"), "mine");

    const r = brief();
    expect(r.sessionIds).toEqual(["ffffffff-6"]);
    expect(r.rows).toEqual([["a.ts", "mine"]]);
  });

  test("a session that ended before the base commit is left out", () => {
    repo.write("a.ts", lines(30));
    repo.commit("base", at(0));
    session("99999999-7", 5).edit(10, "a.ts", (x) => x.replace("line 5\n", "five\n"), "old");
    repo.commit("old work", at(120));
    repo.write("a.ts", readFileSync(join(repo.dir, "a.ts"), "utf8") + "manual\n");

    const r = brief({ worktree: "HEAD" });
    expect(r.sessionIds).toEqual([]);
    expect(r.rows).toEqual([["a.ts", "unexplained"]]);
  });
});

describe("resolveTarget", () => {
  test("commit, root commit and ranges", () => {
    repo.write("a.ts", "1\n");
    const c1 = repo.commit("one", at(0));
    repo.write("a.ts", "2\n");
    const c2 = repo.commit("two", at(1));
    repo.git("checkout", "--quiet", "-b", "side", c1);
    repo.write("b.ts", "side\n");
    const side = repo.commit("side", at(2));

    expect(resolveTarget(repo.dir, { commit: c2 }).target).toEqual({
      kind: "commit",
      base: c1,
      head: c2,
    });
    expect(resolveTarget(repo.dir, { commit: c1 }).target.base).toBe(emptyTree(repo.dir));
    expect(resolveTarget(repo.dir, { commit: c1 }).baseTime).toBeUndefined();
    expect(resolveTarget(repo.dir, { range: `${c2}..${side}` }).target).toEqual({
      kind: "range",
      base: c2,
      head: side,
    });
    // a...b starts where b forked from a.
    expect(resolveTarget(repo.dir, { range: `main...side` }).target.base).toBe(c1);
    expect(resolveTarget(repo.dir, { range: "main..side" }).headTime).toBe(at(2).getTime());
  });

  test("bad requests", () => {
    repo.commit("one");
    expect(() => resolveTarget(repo.dir, { commit: "nope" })).toThrow(TargetError);
    expect(() => resolveTarget(repo.dir, { commit: "--all" })).toThrow(/unknown revision/);
    expect(() => resolveTarget(repo.dir, { range: "main" })).toThrow(/<a>\.\.<b>/);
    expect(() => resolveTarget(repo.dir, { commit: "HEAD", range: "a..b" })).toThrow(/only one/);
  });

  test("briefing ids: stable, and distinct per kind and base", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const id = briefingId({ kind: "worktree", base: a, head: "WORKTREE" });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(briefingId({ kind: "worktree", base: a, head: "WORKTREE" })).toBe(id);
    expect(briefingId({ kind: "worktree", base: b, head: "WORKTREE" })).not.toBe(id);
    expect(briefingId({ kind: "range", base: a, head: b })).not.toBe(
      briefingId({ kind: "commit", base: a, head: b }),
    );
  });

  test("worktree base on a feature branch: oldest session base, clamped to the fork point", () => {
    repo.write("a.ts", "1\n");
    const old = repo.commit("old", at(0));
    // A session on a branch of the same name started before the fork point
    // (branch name reused).
    repo.git("checkout", "--quiet", "-b", "feat");
    session("11111111-8", 1);
    repo.git("checkout", "--quiet", "main");
    repo.git("branch", "--quiet", "-D", "feat");
    repo.write("a.ts", "2\n");
    const fork = repo.commit("main moves on", at(2));
    repo.git("checkout", "--quiet", "-b", "feat");
    repo.write("a.ts", "3\n");
    const mid = repo.commit("on feat", at(3));
    session("22222222-9", 4);

    const sessions = listSessions(repo.dir);
    expect(resolveTarget(repo.dir, {}, sessions).target.base).toBe(fork);
    // Only the later session: its base.
    const later = sessions.filter((s) => s.id.startsWith("2"));
    expect(resolveTarget(repo.dir, {}, later).target.base).toBe(mid);
    // No sessions: the fork point.
    expect(resolveTarget(repo.dir, {}, []).target.base).toBe(fork);
    // Explicit base wins.
    expect(resolveTarget(repo.dir, { worktree: old }, sessions).target.base).toBe(old);
  });

  test("default branch comes from origin/HEAD when there is one", () => {
    repo.write("a.ts", "1\n");
    const c1 = repo.commit("one", at(0));
    repo.git("update-ref", "refs/remotes/origin/trunk", c1);
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    repo.git("checkout", "--quiet", "-b", "trunk");
    repo.write("a.ts", "2\n");
    const c2 = repo.commit("local trunk commit", at(1));

    // On the default branch (by origin/HEAD's name): HEAD, not origin/trunk.
    expect(resolveTarget(repo.dir, {}).target.base).toBe(c2);
    repo.git("checkout", "--quiet", "main");
    // main is now just a feature branch; it forks from origin/trunk at c1.
    expect(resolveTarget(repo.dir, {}).target.base).toBe(c1);
  });

  test("no commits yet: the empty tree", () => {
    expect(resolveTarget(repo.dir, {}).target.base).toBe(emptyTree(repo.dir));
  });
});

describe("mergeSessions", () => {
  const ts = (min: number) => at(min).toISOString();

  test("interleaves by time, keeps each session's order, namespaces ids", () => {
    const a: Event[] = [
      { v: 1, type: "intent", ts: ts(1), id: "i1", why: "a", source: "narration" },
      {
        v: 1,
        type: "edit",
        ts: ts(3),
        id: "e1",
        path: "x",
        tool: "Edit",
        before_hash: null,
        after_hash: null,
      },
      // Transcript time: earlier than the edit it links.
      { v: 1, type: "edit_link", ts: ts(2), edit_id: "e1", intent_id: "i1", msg_ref: "m1" },
    ];
    const b: Event[] = [
      { v: 1, type: "prompt", ts: ts(2), text: "b's prompt" },
      { v: 1, type: "intent", ts: ts(4), id: "p1", why: "plan", source: "plan_step" },
    ];
    const { events, context } = mergeSessions([
      { id: "aaaaaaaa-x", events: a },
      { id: "bbbbbbbb-y", events: b },
    ]);

    expect(events.map((e) => [e.session_id.slice(0, 1), e.type])).toEqual([
      ["a", "intent"],
      ["b", "prompt"],
      ["a", "edit"],
      ["a", "edit_link"],
      ["b", "intent"],
    ]);
    expect(events[3]).toMatchObject({
      edit_id: "aaaaaaaa:e1",
      intent_id: "aaaaaaaa:i1",
      msg_ref: "aaaaaaaa:m1",
    });
    expect(context[1]).toEqual({
      sessionId: "bbbbbbbb-y",
      prompts: ["b's prompt"],
      plan: [{ id: "bbbbbbbb:p1", why: "plan" }],
    });
  });
});

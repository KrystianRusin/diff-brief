import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { targetContents } from "../../src/diff/contents.js";
import { computeDiff, type Hunk } from "../../src/diff/index.js";
import { mapHunks, type MappingMode } from "../../src/mapping/index.js";
import type { Event } from "../../src/schema/events.js";
import { hashContent } from "../../src/store/blobs.js";
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

const lines = (n: number, label = "line") =>
  Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

// Builds a session the way the DB-05 adapter records it: edits and external
// changes with before/after snapshots, against a committed base.
function scenario(base: Record<string, string>) {
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  const baseSha = repo.commit("base");
  const blobs = new Map<string, Buffer>();
  const current = new Map<string, string | null>(Object.entries(base));
  const events: Event[] = [];
  let clock = Date.parse("2026-10-21T10:00:00Z");
  let ids = 0;
  const ts = () => new Date((clock += 1000)).toISOString();
  const snap = (c: string | null) => {
    if (c === null) return null;
    const h = hashContent(c);
    blobs.set(h, Buffer.from(c));
    return h;
  };
  const setDisk = (path: string, content: string | null) => {
    if (content === null) rmSync(join(repo.dir, path), { force: true });
    else repo.write(path, content);
    current.set(path, content);
  };

  return {
    events,
    blobs,
    // Agent edit; returns its id.
    edit(path: string, content: string, intentId?: string, opts: { store?: boolean } = {}) {
      const id = `e${++ids}`;
      const before = snap(current.get(path) ?? null);
      const after = opts.store === false ? hashContent(content) : snap(content);
      events.push({
        v: 1,
        type: "edit",
        ts: ts(),
        id,
        path,
        tool: "Edit",
        before_hash: before,
        after_hash: after,
        ...(intentId ? { intent_id: intentId } : {}),
        ...(opts.store === false ? { too_large: true } : {}),
      });
      setDisk(path, content);
      return id;
    },
    link(editId: string, intentId: string) {
      events.push({ v: 1, type: "edit_link", ts: ts(), edit_id: editId, intent_id: intentId });
    },
    // Change outside the agent's edits; `logged` adds the external_change
    // event DB-05 writes when it notices one.
    external(path: string, content: string | null, logged = false) {
      if (logged) {
        events.push({
          v: 1,
          type: "external_change",
          ts: ts(),
          path,
          before_hash: snap(current.get(path) ?? null),
          after_hash: snap(content),
        });
      }
      setDisk(path, content);
    },
    current: (path: string) => current.get(path) ?? "",
    map(mode?: MappingMode) {
      const spec = { kind: "worktree" as const, base: baseSha };
      const { hunks } = computeDiff(repo.dir, spec);
      const result = mapHunks({
        hunks,
        events,
        contents: targetContents(repo.dir, spec),
        blob: (h) => blobs.get(h) ?? null,
        ...(mode ? { mode } : {}),
      });
      const of = (h: Hunk) => ({ ...h, ...result.byHunk[h.id]! });
      return { hunks: hunks.map(of), deadEnds: result.deadEnds };
    },
  };
}

describe("line mode", () => {
  test("each hunk gets the intent of the edit that wrote it", () => {
    const s = scenario({ "a.ts": lines(60) });
    s.edit("a.ts", s.current("a.ts").replace("line 10\n", "ten\n"), "i1");
    s.edit("a.ts", s.current("a.ts").replace("line 50\n", "fifty\n"), "i2");

    const { hunks, deadEnds } = s.map();
    expect(hunks.map((h) => [h.intentId, h.history, h.editIds, h.mode])).toEqual([
      ["i1", [], ["e1"], "line"],
      ["i2", [], ["e2"], "line"],
    ]);
    expect(hunks.every((h) => !h.externalTouched && !h.serves)).toBe(true);
    expect(deadEnds).toEqual([]);
  });

  test("line numbers drifting between edits don't matter", () => {
    const s = scenario({ "a.ts": lines(60) });
    s.edit("a.ts", s.current("a.ts").replace("line 50\n", "fifty\n"), "late");
    // Inserting 20 lines above moves the first edit's line down.
    s.edit("a.ts", s.current("a.ts").replace("line 5\n", lines(20, "new")), "early");

    const { hunks } = s.map();
    expect(hunks.map((h) => [h.path, h.newStart, h.intentId])).toEqual([
      ["a.ts", 2, "early"],
      ["a.ts", 66, "late"],
    ]);
  });

  test("most lines wins; a tie goes to the most recent edit", () => {
    const s = scenario({ "a.ts": lines(10) });
    s.edit("a.ts", s.current("a.ts").replace("line 5\n", "line 5\na\nb\nc\n"), "big");
    s.edit("a.ts", s.current("a.ts").replace("c\n", "c\nd\n"), "small");
    expect(s.map().hunks.map((h) => [h.intentId, h.history])).toEqual([["big", ["small"]]]);

    const t = scenario({ "b.ts": lines(10) });
    t.edit("b.ts", t.current("b.ts").replace("line 5\n", "line 5\nx\n"), "first");
    t.edit("b.ts", t.current("b.ts").replace("x\n", "x\ny\n"), "second");
    expect(t.map().hunks.find((h) => h.path === "b.ts")!.intentId).toBe("second");
  });

  test("wholesale rewrite: the rewrite owns the hunk, the first version is a dead end", () => {
    const s = scenario({ "a.ts": "old\n" });
    const first = s.edit("a.ts", lines(5, "draft"), "draft");
    const second = s.edit("a.ts", lines(5, "final"), "final");

    const { hunks, deadEnds } = s.map();
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      intentId: "final",
      history: ["draft"],
      editIds: [first, second],
    });
    expect(deadEnds).toEqual([{ editId: first, intentId: "draft", removedByEditId: second }]);
  });

  test("edit then partial revert keeps the surviving part on the original intent", () => {
    const s = scenario({ "a.ts": lines(60) });
    s.edit(
      "a.ts",
      s
        .current("a.ts")
        .replace("line 10\n", "line 10\nkeep 1\nkeep 2\n")
        .replace("line 50\n", "line 50\ndrop 1\ndrop 2\n"),
      "feature",
    );
    s.edit("a.ts", s.current("a.ts").replace("drop 1\ndrop 2\n", ""), "revert");

    const { hunks, deadEnds } = s.map();
    expect(hunks.map((h) => [h.newStart, h.intentId])).toEqual([[8, "feature"]]);
    expect(deadEnds).toEqual([]);
  });

  test("deletion-only hunk goes to the edit that removed the lines", () => {
    const s = scenario({ "a.ts": lines(30) });
    s.edit("a.ts", s.current("a.ts").replace("line 10\nline 11\nline 12\n", ""), "remove helper");

    const [h] = s.map().hunks;
    expect(h!.lines.every((l) => l.kind !== "+")).toBe(true);
    expect(h).toMatchObject({ intentId: "remove helper", externalTouched: false });
  });

  test("an edit that only re-indents still owns those lines", () => {
    const s = scenario({ "a.ts": "if (x) {\n  return 1;\n}\n" });
    s.edit("a.ts", "if (x) {\n    return 1;\n}\n", "indent");
    expect(s.map().hunks[0]).toMatchObject({ intentId: "indent", externalTouched: false });
  });

  test("intents from later edit_link events apply, the last link winning", () => {
    const s = scenario({ "a.ts": lines(10) });
    const id = s.edit("a.ts", s.current("a.ts").replace("line 5\n", "five\n"));
    s.link(id, "first guess");
    s.link(id, "narration");
    expect(s.map().hunks[0]!.intentId).toBe("narration");
  });

  test("a link wins even when a merged timeline puts it before its edit", () => {
    const s = scenario({ "a.ts": lines(10) });
    s.edit("a.ts", s.current("a.ts").replace("line 5\n", "five\n"), "edit's own");
    s.link("e1", "linked");
    s.events.unshift(s.events.pop()!);
    expect(s.map().hunks[0]!.intentId).toBe("linked");
  });
});

describe("external changes", () => {
  test("formatter re-indenting the agent's code keeps the agent's intent", () => {
    const s = scenario({ "a.ts": lines(10) });
    s.edit(
      "a.ts",
      s.current("a.ts").replace("line 5\n", "const a  =  1;\n    call(a);\n"),
      "add a",
    );
    // Not logged: ran after the session ended. Touches every line the edit wrote.
    s.external(
      "a.ts",
      s.current("a.ts").replace("const a  =  1;\n    call(a);", "const a = 1;\n  call(a);"),
    );

    expect(s.map().hunks).toEqual([
      expect.objectContaining({ intentId: "add a", externalTouched: true, mode: "line" }),
    ]);
  });

  test("a line only the formatter added is unexplained", () => {
    const s = scenario({ "a.ts": lines(40) });
    s.edit("a.ts", s.current("a.ts").replace("line 5\n", "five\n"), "fix");
    s.external("a.ts", s.current("a.ts") + "// touched by script\n", true);

    const { hunks } = s.map();
    expect(hunks.map((h) => [h.intentId, h.serves, h.externalTouched])).toEqual([
      ["fix", undefined, false],
      [undefined, "unexplained", true],
    ]);
  });

  test("manual edit mid-session that the hooks missed becomes external", () => {
    const s = scenario({ "a.ts": lines(60) });
    s.edit("a.ts", s.current("a.ts").replace("line 10\n", "ten\n"), "first");
    // Changed on disk with no event; the next edit's before shows the gap.
    s.external("a.ts", s.current("a.ts").replace("line 30\n", "manual\n"));
    s.edit("a.ts", s.current("a.ts").replace("line 50\n", "fifty\n"), "second");

    expect(s.map().hunks.map((h) => [h.intentId, h.serves, h.externalTouched])).toEqual([
      ["first", undefined, false],
      [undefined, "unexplained", true],
      ["second", undefined, false],
    ]);
  });

  test("mv at the end keeps the intents from the old path", () => {
    const s = scenario({ "old.ts": lines(30) });
    s.edit("old.ts", s.current("old.ts").replace("line 10\n", "ten\n"), "fix");
    const moved = s.current("old.ts");
    // What DB-05 logs at SessionEnd after a Bash `git mv`.
    s.external("old.ts", null, true);
    s.external("new.ts", moved, true);
    repo.git("add", "-A");

    const { hunks, deadEnds } = s.map();
    expect(hunks).toEqual([
      expect.objectContaining({
        path: "new.ts",
        oldPath: "old.ts",
        status: "renamed",
        intentId: "fix",
      }),
    ]);
    expect(deadEnds).toEqual([]);
  });

  test("mv mid-session, then more edits on the new path", () => {
    const s = scenario({ "old.ts": lines(60) });
    s.edit("old.ts", s.current("old.ts").replace("line 10\n", "ten\n"), "before move");
    const moved = s.current("old.ts");
    s.external("new.ts", moved, true); // logged by the next edit's baseline check
    s.edit("new.ts", moved.replace("line 50\n", "fifty\n"), "after move");
    s.external("old.ts", null, true); // logged at SessionEnd

    expect(s.map().hunks.map((h) => [h.path, h.status, h.intentId])).toEqual([
      ["new.ts", "renamed", "before move"],
      ["new.ts", "renamed", "after move"],
    ]);
  });

  test("mv logged before an edit that deletes base lines on the new path", () => {
    // Session 1 ends with a mv; session 2 (merged by DB-09) deletes lines.
    const s = scenario({ "old.ts": lines(30) });
    const moved = s.current("old.ts");
    s.external("old.ts", null, true);
    s.external("new.ts", moved, true);
    s.edit("new.ts", moved.replace("line 20\nline 21\n", ""), "drop dead code");

    expect(s.map().hunks.map((h) => [h.path, h.status, h.intentId, h.externalTouched])).toEqual([
      ["new.ts", "renamed", "drop dead code", false],
    ]);
  });

  test("deleting a file outside the agent is unexplained", () => {
    const s = scenario({ "a.ts": lines(5), "b.ts": lines(5) });
    s.external("a.ts", null, true);
    expect(s.map().hunks).toEqual([
      expect.objectContaining({
        path: "a.ts",
        status: "deleted",
        serves: "unexplained",
        externalTouched: true,
      }),
    ]);
  });
});

describe("dead ends", () => {
  test("a change fully reverted by a later edit, in a file no longer in the diff", () => {
    const s = scenario({ "a.ts": lines(5), "b.ts": lines(5) });
    const tried = s.edit("a.ts", s.current("a.ts").replace("line 2\n", "attempt\n"), "approach A");
    const undo = s.edit("a.ts", lines(5), "back out A");
    s.edit("b.ts", s.current("b.ts").replace("line 2\n", "two\n"), "approach B");

    const { hunks, deadEnds } = s.map();
    expect(hunks.map((h) => [h.path, h.intentId])).toEqual([["b.ts", "approach B"]]);
    expect(deadEnds).toEqual([{ editId: tried, intentId: "approach A", removedByEditId: undo }]);
  });

  test("a created file deleted outside the agent has no remover edit", () => {
    const s = scenario({ "a.ts": lines(5) });
    const tried = s.edit("scratch.ts", "temp\n", "scratch");
    s.external("scratch.ts", null, true);
    expect(s.map().deadEnds).toEqual([{ editId: tried, intentId: "scratch" }]);
  });
});

describe("file mode", () => {
  test("a missing snapshot falls back to file mode for that file only", () => {
    const s = scenario({ "big.ts": lines(10), "a.ts": lines(10) });
    s.edit("big.ts", s.current("big.ts").replace("line 2\n", "two\n"), "first");
    s.edit("big.ts", s.current("big.ts").replace("line 9\n", "nine\n"), "second", { store: false });
    s.edit("a.ts", s.current("a.ts").replace("line 2\n", "two\n"), "other");

    const { hunks, deadEnds } = s.map();
    expect(hunks.map((h) => [h.path, h.intentId, h.history, h.mode])).toEqual([
      ["a.ts", "other", [], "line"],
      ["big.ts", "second", ["first"], "file"],
    ]);
    expect(deadEnds).toEqual([]);
  });

  test("forced file mode, and hunks without lines (binary, pure rename)", () => {
    const s = scenario({ "a.ts": lines(60), "img.bin": "\0old" });
    s.edit("a.ts", s.current("a.ts").replace("line 10\n", "ten\n"), "first");
    s.edit("a.ts", s.current("a.ts").replace("line 50\n", "fifty\n"), "second");
    s.edit("img.bin", "\0new", "new icon");

    expect(s.map("file").hunks.map((h) => [h.path, h.intentId, h.history, h.mode])).toEqual([
      ["a.ts", "second", ["first"], "file"],
      ["a.ts", "second", ["first"], "file"],
      ["img.bin", "new icon", [], "file"],
    ]);
    expect(s.map().hunks.find((h) => h.path === "img.bin")).toMatchObject({
      intentId: "new icon",
      mode: "file",
    });
  });
});

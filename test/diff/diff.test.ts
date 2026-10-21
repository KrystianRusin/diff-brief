import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  computeDiff,
  contentHashOf,
  emptyTree,
  type DiffSpec,
  type Hunk,
} from "../../src/diff/index.js";
import { parseDiff } from "../../src/diff/parse.js";
import { makeTempRepo, type TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

// computeDiff runs git with process.env; keep the developer's config out.
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

function worktree(): { hunks: Hunk[]; stats: ReturnType<typeof computeDiff>["stats"] } {
  return computeDiff(repo.dir, { kind: "worktree", base: repo.git("rev-parse", "HEAD") });
}

const added = (h: Hunk) => h.lines.filter((l) => l.kind === "+").map((l) => l.text);
const removed = (h: Hunk) => h.lines.filter((l) => l.kind === "-").map((l) => l.text);

describe("worktree diffs", () => {
  test("modified file: hunk position, line numbers, stats", () => {
    repo.write("a.txt", lines(20));
    repo.commit("init");
    repo.write("a.txt", lines(20).replace("line 10\n", "line ten\n"));

    const { hunks, stats } = worktree();
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h).toMatchObject({
      path: "a.txt",
      status: "modified",
      oldStart: 7,
      oldLines: 7,
      newStart: 7,
      newLines: 7,
    });
    expect(h.id).toMatch(/^h[0-9a-f]{8}$/);
    expect(removed(h)).toEqual(["line 10"]);
    expect(added(h)).toEqual(["line ten"]);
    expect(h.lines.find((l) => l.kind === "+")).toMatchObject({ newNo: 10 });
    expect(h.lines.find((l) => l.kind === "-")).toMatchObject({ oldNo: 10 });
    expect(h.lines[0]).toMatchObject({ kind: " ", text: "line 7", oldNo: 7, newNo: 7 });
    expect(stats).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });

  test("untracked file is included and the real index is left alone", () => {
    repo.write("a.txt", "a\n");
    repo.commit("init");
    repo.write("a.txt", "a\nstaged\n");
    repo.git("add", "a.txt");
    repo.write("a.txt", "a\nstaged\nunstaged\n");
    repo.write("new/b.txt", "one\ntwo\n");
    const indexBefore = repo.git("ls-files", "--stage");
    const statusBefore = repo.git("status", "--porcelain");

    const { hunks } = worktree();
    expect(hunks.map((h) => [h.path, h.status])).toEqual([
      ["a.txt", "modified"],
      ["new/b.txt", "added"],
    ]);
    expect(added(hunks[0]!)).toEqual(["staged", "unstaged"]);
    expect(hunks[1]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });

    expect(repo.git("ls-files", "--stage")).toBe(indexBefore);
    expect(repo.git("status", "--porcelain")).toBe(statusBefore);
  });

  test("ignored files stay out; tracked files matching .gitignore aren't shown as deleted", () => {
    repo.write("keep.log", "tracked before the ignore rule\n");
    repo.commit("init");
    repo.write(".gitignore", "*.log\n");
    repo.write("debug.log", "noise\n");

    expect(worktree().hunks.map((h) => h.path)).toEqual([".gitignore"]);
  });

  test("deleted file: deletion-only hunk hashes its removed lines", () => {
    repo.write("gone.txt", "x\ny\n");
    repo.write("other.txt", "x\ny\n");
    repo.commit("init");
    repo.git("rm", "--quiet", "gone.txt");

    const [h] = worktree().hunks;
    expect(h).toMatchObject({ path: "gone.txt", status: "deleted", newStart: 0, newLines: 0 });
    expect(removed(h!)).toEqual(["x", "y"]);
    // Same text added would hash differently from it being removed.
    expect(h!.contentHash).toBe(contentHashOf([...h!.lines]));
    expect(h!.contentHash).not.toBe(
      contentHashOf(h!.lines.map((l) => ({ ...l, kind: "+" as const }))),
    );
  });

  test("renamed with edits", () => {
    repo.write("old/name.ts", lines(30));
    repo.commit("init");
    repo.git("mv", "old/name.ts", "new-name.ts");
    repo.write("new-name.ts", lines(30).replace("line 15\n", "line fifteen\n"));

    const { hunks, stats } = worktree();
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      path: "new-name.ts",
      oldPath: "old/name.ts",
      status: "renamed",
    });
    expect(added(hunks[0]!)).toEqual(["line fifteen"]);
    expect(stats).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });

  test("pure rename gets one empty hunk", () => {
    repo.write("a.ts", lines(10));
    repo.commit("init");
    repo.git("mv", "a.ts", "b.ts");

    const { hunks, stats } = worktree();
    expect(hunks).toEqual([
      expect.objectContaining({ path: "b.ts", oldPath: "a.ts", status: "renamed", lines: [] }),
    ]);
    expect(stats).toEqual({ files: 1, insertions: 0, deletions: 0 });
  });

  test("binary file: one empty hunk whose hash follows the content", () => {
    const bin = (n: number) => Buffer.from([0, 1, 2, n, 0, 255]);
    repo.write("img.bin", "placeholder\n");
    repo.commit("init");
    repo.write("img.bin", bin(1).toString("latin1"));
    const first = worktree().hunks;
    repo.write("img.bin", bin(2).toString("latin1"));
    const second = worktree().hunks;

    expect(first).toEqual([
      expect.objectContaining({ path: "img.bin", status: "binary", lines: [] }),
    ]);
    expect(second[0]!.contentHash).not.toBe(first[0]!.contentHash);
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });

  test("CRLF file keeps \\r in the text but hashes like its LF twin", () => {
    repo.write("dos.txt", "a\r\nb\r\n");
    repo.write("unix.txt", "a\nb\n");
    repo.commit("init");
    repo.write("dos.txt", "a\r\nb\r\nnew line\r\n");
    repo.write("unix.txt", "a\nb\nnew line\n");

    const [dos, unix] = worktree().hunks;
    expect(added(dos!)).toEqual(["new line\r"]);
    expect(added(unix!)).toEqual(["new line"]);
    expect(dos!.contentHash).toBe(unix!.contentHash);
    expect(dos!.id).not.toBe(unix!.id); // different paths
  });

  test("no trailing newline is flagged on the line it applies to", () => {
    repo.write("a.txt", "one\ntwo");
    repo.commit("init");
    repo.write("a.txt", "one\ntwo\nthree");

    const [h] = worktree().hunks;
    expect(h!.lines).toEqual([
      { kind: " ", text: "one", oldNo: 1, newNo: 1 },
      { kind: "-", text: "two", oldNo: 2, noNewline: true },
      { kind: "+", text: "two", newNo: 2 },
      { kind: "+", text: "three", newNo: 3, noNewline: true },
    ]);
  });

  test("ids are stable when an unrelated hunk elsewhere in the file changes", () => {
    repo.write("a.txt", lines(100));
    repo.commit("init");
    const edit = (top: string) =>
      lines(100).replace("line 5\n", `${top}\n`).replace("line 80\n", "line eighty\n");

    repo.write("a.txt", edit("first try"));
    const before = worktree().hunks;
    repo.write("a.txt", edit("second try\nwith an extra line"));
    const after = worktree().hunks;

    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(after[0]!.id).not.toBe(before[0]!.id);
    // The bottom hunk moved down a line but kept its id.
    expect(after[1]!.newStart).toBe(before[1]!.newStart + 1);
    expect(after[1]!.id).toBe(before[1]!.id);
  });

  test("identical added lines in one file get -2, -3 in file order", () => {
    repo.write("a.txt", lines(60));
    repo.commit("init");
    repo.write(
      "a.txt",
      lines(60)
        .replace("line 5\n", "line 5\nlog();\n")
        .replace("line 30\n", "line 30\nlog();\n")
        .replace("line 55\n", "line 55\nlog();\n"),
    );

    const ids = worktree().hunks.map((h) => h.id);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(`${ids[0]}-2`);
    expect(ids[2]).toBe(`${ids[0]}-3`);
  });

  test("whitespace-only reformatting keeps the content hash", () => {
    repo.write("a.ts", "x\n");
    repo.commit("init");
    repo.write("a.ts", "x\nif (a) {  return  b; }\n\n");
    const tight = worktree().hunks[0]!.contentHash;
    repo.write("a.ts", "x\nif (a) { return b; }   \n");
    expect(worktree().hunks[0]!.contentHash).toBe(tight);
  });

  test("quoted and non-ASCII paths", () => {
    repo.write("seed.txt", "s\n");
    repo.commit("init");
    const names = [
      "with space.txt",
      'quote"d.txt',
      "back\\slash.txt",
      "café/naïve.txt",
      "tab\there.bin",
    ];
    for (const n of names) repo.write(n, n.endsWith(".bin") ? "\0bin" : "hi\n");

    expect(
      worktree()
        .hunks.map((h) => h.path)
        .sort(),
    ).toEqual([...names].sort());
  });

  test("removed lines that look like file headers don't confuse the parser", () => {
    repo.write("a.md", "keep\n-- dash\n++ plus\nend\n");
    repo.commit("init");
    repo.write("a.md", "keep\nend\n");

    const [h] = worktree().hunks;
    expect(removed(h!)).toEqual(["-- dash", "++ plus"]);
  });

  test("user git config doesn't change the result", () => {
    repo.write("a.txt", lines(40));
    repo.write("b c.txt", "x\n");
    repo.commit("init");
    repo.write("a.txt", lines(40).replace("line 10\n", "ten\n").replace("line 17\n", "17\n"));
    repo.write("b c.txt", "y\n");
    const plain = worktree();

    for (const [k, v] of [
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.context", "10"],
      ["diff.interHunkContext", "20"],
      ["diff.algorithm", "patience"],
      ["diff.renames", "false"],
      ["diff.external", "false"],
      ["color.ui", "always"],
      ["core.quotepath", "true"],
    ]) {
      repo.git("config", k!, v!);
    }
    expect(worktree()).toEqual(plain);
  });

  test("repo with no commits diffs against the empty tree", () => {
    repo.write("a.txt", "hello\n");
    const { hunks } = computeDiff(repo.dir, { kind: "worktree", base: emptyTree(repo.dir) });
    expect(hunks).toEqual([expect.objectContaining({ path: "a.txt", status: "added" })]);
  });

  test("large untracked file", () => {
    repo.write("seed.txt", "s\n");
    repo.commit("init");
    repo.write("big.txt", lines(200_000));

    const start = performance.now();
    const { hunks, stats } = worktree();
    expect(performance.now() - start).toBeLessThan(5000);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.newLines).toBe(200_000);
    expect(stats.insertions).toBe(200_000);
  });

  test("rejects revisions that look like flags", () => {
    expect(() => computeDiff(repo.dir, { kind: "worktree", base: "--output=x" })).toThrow(
      /invalid revision/,
    );
  });
});

describe("commit and range targets", () => {
  test("commit target diffs against its parent", () => {
    repo.write("a.txt", "one\n");
    repo.commit("init");
    repo.write("a.txt", "one\ntwo\n");
    const sha = repo.commit("second");
    repo.write("a.txt", "one\ntwo\nworktree only\n");

    const { hunks } = computeDiff(repo.dir, { kind: "commit", sha });
    expect(hunks.flatMap(added)).toEqual(["two"]);
  });

  test("root commit diffs against the empty tree", () => {
    repo.write("a.txt", "one\n");
    const sha = repo.commit("init");

    const { hunks } = computeDiff(repo.dir, { kind: "commit", sha });
    expect(hunks).toEqual([expect.objectContaining({ path: "a.txt", status: "added" })]);
  });

  test("range target, and ids match the same change seen in the worktree", () => {
    repo.write("a.txt", lines(10));
    const base = repo.commit("init");
    repo.write("a.txt", lines(10).replace("line 3\n", "three\n"));
    const fromWorktree = worktree().hunks;
    const head = repo.commit("change");
    repo.write("b.txt", "later\n");
    repo.commit("later");

    const spec: DiffSpec = { kind: "range", base, head };
    expect(computeDiff(repo.dir, spec).hunks).toEqual(fromWorktree);
  });
});

describe("parseDiff", () => {
  test("hunk header with omitted counts", () => {
    const [file] = parseDiff(
      [
        "diff --git a/x b/x",
        "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    expect(file!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    expect(file!.oldBlob).toBe("1".repeat(40));
  });
});

describe("diffbrief's own store", () => {
  test("is never in the diff, ignored or not", () => {
    repo.write("a.txt", "a\n");
    repo.commit("init");
    repo.write(".diffbrief/sessions/x/events.jsonl", "{}\n");
    repo.write("a.txt", "b\n");
    expect(worktree().hunks.map((h) => h.path)).toEqual(["a.txt"]);

    repo.write(".gitignore", ".diffbrief/\n");
    expect(worktree().hunks.map((h) => h.path)).toEqual([".gitignore", "a.txt"]);
  });
});

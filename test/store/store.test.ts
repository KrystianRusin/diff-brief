import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Event } from "../../src/schema/events.js";
import { UnsupportedVersionError } from "../../src/schema/version.js";
import { getBlob, hashContent, putBlob } from "../../src/store/blobs.js";
import {
  blobPath,
  eventsPath,
  findRepoRoot,
  sessionDir,
  statePath,
} from "../../src/store/layout.js";
import {
  listSessions,
  readAnnotations,
  readEvents,
  writeAnnotations,
} from "../../src/store/read.js";
import { appendEvent, readState, writeState } from "../../src/store/sessions.js";
import { makeTempRepo } from "../helpers/temp-repo.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "diffbrief-store-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ts = "2026-10-20T15:00:00.000Z";
const start = (id: string, at: string): Event => ({
  v: 1,
  type: "session_start",
  ts: at,
  agent: "claude-code",
  session_id: id,
  base_sha: "a1b2c3",
  branch: "feat/x",
  cwd: "/repo",
});
const edit = (id: string): Event => ({
  v: 1,
  type: "edit",
  ts,
  id,
  path: "a.ts",
  tool: "Edit",
  before_hash: null,
  after_hash: "a".repeat(64),
});

describe("events", () => {
  test("append then read back", () => {
    appendEvent(root, "s1", start("s1", ts));
    appendEvent(root, "s1", edit("e1"));
    const { events, skipped } = readEvents(root, "s1");
    expect(events.map((e) => e.type)).toEqual(["session_start", "edit"]);
    expect(skipped).toEqual([]);
  });

  test("missing session reads as empty", () => {
    expect(readEvents(root, "nope")).toEqual({ events: [], skipped: [] });
  });

  test("skips a truncated last line", () => {
    appendEvent(root, "s1", start("s1", ts));
    appendFileSync(eventsPath(root, "s1"), '{"v":1,"type":"prom');
    const { events, skipped } = readEvents(root, "s1");
    expect(events).toHaveLength(1);
    expect(skipped).toEqual([{ line: 2, reason: "truncated last line" }]);
  });

  test("skips bad lines in the middle and keeps going", () => {
    appendEvent(root, "s1", start("s1", ts));
    appendFileSync(eventsPath(root, "s1"), "not json\n" + '{"v":1,"type":"bogus","ts":"x"}\n');
    appendEvent(root, "s1", edit("e1"));
    const { events, skipped } = readEvents(root, "s1");
    expect(events.map((e) => e.type)).toEqual(["session_start", "edit"]);
    expect(skipped.map((s) => s.reason)).toEqual(["invalid JSON", "does not match event schema"]);
  });

  test("lines from a newer diffbrief throw instead of being skipped", () => {
    appendEvent(root, "s1", start("s1", ts));
    appendFileSync(
      eventsPath(root, "s1"),
      JSON.stringify({ v: 2, type: "prompt", ts, text: "x" }) + "\n",
    );
    expect(() => readEvents(root, "s1")).toThrow(UnsupportedVersionError);
  });

  test("concurrent appends from separate processes don't interleave", async () => {
    const workers = 8;
    const perWorker = 100;
    const worker = join(import.meta.dirname, "../helpers/append-worker.ts");
    await Promise.all(
      Array.from({ length: workers }, (_, w) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", worker, root, "s1", String(w), String(perWorker)],
          { stdio: "inherit" },
        );
        return new Promise<void>((resolve, reject) =>
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))),
        );
      }),
    );
    const { events, skipped } = readEvents(root, "s1");
    expect(skipped).toEqual([]);
    expect(events).toHaveLength(workers * perWorker);
    expect(new Set(events.map((e) => (e as { id: string }).id)).size).toBe(workers * perWorker);
  }, 30_000);
});

describe("state", () => {
  test("round-trips", () => {
    writeState(root, "s1", { lastHash: { "a.ts": "abc" } });
    expect(readState(root, "s1")).toEqual({ lastHash: { "a.ts": "abc" } });
  });

  test("missing or corrupt state reads as undefined", () => {
    expect(readState(root, "s1")).toBeUndefined();
    writeState(root, "s1", {});
    writeFileSync(statePath(root, "s1"), "{corrupt");
    expect(readState(root, "s1")).toBeUndefined();
  });

  test("leaves no temp files behind", () => {
    writeState(root, "s1", { a: 1 });
    writeState(root, "s1", { a: 2 });
    expect(readdirSync(sessionDir(root, "s1"))).toEqual(["state.json"]);
  });
});

describe("blobs", () => {
  test("round-trips and stores gzipped", () => {
    const content = Buffer.from("export const a = 1;\n".repeat(100));
    const hash = putBlob(root, content);
    expect(hash).toBe(hashContent(content));
    expect(getBlob(root, hash)).toEqual(content);
    expect(readFileSync(blobPath(root, hash)).length).toBeLessThan(content.length);
  });

  test("dedupes identical content", () => {
    const a = putBlob(root, "same");
    const b = putBlob(root, Buffer.from("same"));
    expect(a).toBe(b);
    expect(readdirSync(dirname(blobPath(root, a)))).toEqual([a]);
  });

  test("handles empty files", () => {
    const hash = putBlob(root, "");
    expect(getBlob(root, hash)).toEqual(Buffer.alloc(0));
  });
});

describe("sessions list", () => {
  test("newest first with counts", () => {
    appendEvent(root, "old", start("old", "2026-10-19T10:00:00.000Z"));
    appendEvent(root, "new", start("new", "2026-10-20T10:00:00.000Z"));
    appendEvent(root, "new", edit("e1"));
    appendEvent(root, "new", edit("e2"));
    appendEvent(root, "new", { v: 1, type: "session_end", ts });

    const list = listSessions(root);
    expect(list.map((s) => s.id)).toEqual(["new", "old"]);
    expect(list[0]).toMatchObject({ edits: 2, commands: 0, endedAt: ts, branch: "feat/x" });
    expect(list[1]?.endedAt).toBeUndefined();
  });

  test("empty store lists nothing", () => {
    expect(listSessions(root)).toEqual([]);
  });
});

describe("annotations", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/annotations/example.json", import.meta.url), "utf8"),
  );

  test("write then read", () => {
    writeAnnotations(root, "b1", fixture);
    expect(readAnnotations(root, "b1")).toEqual(fixture);
  });

  test("missing briefing reads as undefined", () => {
    expect(readAnnotations(root, "b1")).toBeUndefined();
  });

  test("refuses to write invalid annotations", () => {
    expect(() => writeAnnotations(root, "b1", { ...fixture, read_first: ["hnope"] })).toThrow();
    expect(readAnnotations(root, "b1")).toBeUndefined();
  });
});

describe("layout", () => {
  test("rejects ids that would escape the store", () => {
    expect(() => eventsPath(root, "../escape")).toThrow(/invalid session id/);
    expect(() => eventsPath(root, "")).toThrow();
    expect(() => eventsPath(root, ".hidden")).toThrow();
  });

  test("findRepoRoot finds the toplevel from a subdirectory", () => {
    const repo = makeTempRepo();
    try {
      repo.write("src/deep/a.ts", "");
      expect(findRepoRoot(join(repo.dir, "src/deep"))).toBe(repo.dir);
      expect(findRepoRoot(root)).toBeNull();
    } finally {
      repo.cleanup();
    }
  });
});

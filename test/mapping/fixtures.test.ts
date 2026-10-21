import { afterEach, expect, test } from "vitest";
import { targetContents } from "../../src/diff/contents.js";
import { computeDiff } from "../../src/diff/index.js";
import { mapHunks } from "../../src/mapping/index.js";
import { parseEvent, type EventOf } from "../../src/schema/events.js";
import { getBlob, hasBlob } from "../../src/store/blobs.js";
import { replayFixture, type ReplayResult } from "../helpers/replay.js";

// The DB-04 recordings, captured by the DB-05 adapter and mapped end to end.

const runs: ReplayResult[] = [];
afterEach(() => runs.splice(0).forEach((r) => r.cleanup()));

function mapFixture(name: string) {
  const run = replayFixture(name);
  runs.push(run);
  const root = run.repo.dir;
  const events = run.lines.map((l) => parseEvent(JSON.parse(l)));
  const start = events[0] as EventOf<"session_start">;
  const spec = { kind: "worktree" as const, base: start.base_sha };
  const { hunks } = computeDiff(root, spec);
  const { byHunk, deadEnds } = mapHunks({
    hunks,
    events,
    contents: targetContents(root, spec),
    blob: (h) => (hasBlob(root, h) ? getBlob(root, h) : null),
  });
  const why = new Map(events.flatMap((e) => (e.type === "intent" ? [[e.id, e]] : [])));
  return {
    rows: hunks.map((h) => {
      const m = byHunk[h.id]!;
      return [
        h.path,
        m.intentId && why.get(m.intentId)!.source,
        m.intentId ?? m.serves,
        m.history,
        m.externalTouched,
      ];
    }),
    deadEnds,
  };
}

test("bugfix-basic: unnarrated writes fall back to the prompt", () => {
  expect(mapFixture("bugfix-basic")).toEqual({
    rows: [
      ["src/order.js", "prompt", "i1", [], false],
      ["test/order.test.js", "prompt", "i1", [], false],
    ],
    deadEnds: [],
  });
});

test("subagent-tasks: plan steps, the narrated fix in history, the script's line unexplained", () => {
  expect(mapFixture("subagent-tasks")).toEqual({
    rows: [
      ["src/cart.js", undefined, "unexplained", [], true],
      ["src/format.js", "plan_step", "p1", [], false],
      ["src/order.js", "plan_step", "p2", [], false],
      // Written expecting 81 under p3, then corrected after "The test failed as intended".
      ["test/order.test.js", "plan_step", "p3", ["i1"], false],
    ],
    deadEnds: [],
  });
});

test("tool-failures: failed edits leave nothing to map", () => {
  expect(mapFixture("tool-failures")).toEqual({ rows: [], deadEnds: [] });
});

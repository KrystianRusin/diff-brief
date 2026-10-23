import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadBriefingInputs } from "../../src/briefing/inputs.js";
import { renderShow, testFiles } from "../../src/commands/show.js";
import { replayFixture, type ReplayResult } from "../helpers/replay.js";

let run: ReplayResult;

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  run = replayFixture("subagent-tasks");
});
afterEach(() => {
  run.cleanup();
  vi.unstubAllEnvs();
});

test("groups the recorded worktree diff by reason", () => {
  const out = renderShow(loadBriefingInputs(run.repo.dir, {}), { diff: false });
  const lines = out.split("\n");
  expect(lines[2]).toBe("4 hunks: 4 explained by 4 intents, 0 unexplained");
  const groups = lines.filter((l) => l.startsWith("▸"));
  expect(groups.map((g) => g.split(" · ")[0])).toEqual([
    "▸ read these first",
    "▸ plan step",
    "▸ delegated to a subagent",
    "▸ plan step",
    "▸ plan step",
  ]);
  expect(out).toContain("Fix double discount in src/order.js");
  expect(out).toContain("Run formatter-simulation script on src/cart.js");
  // The order fix was tested; the script that appended to cart.js ran last.
  expect(out).toMatch(/src\/order.js @@ \S+ \S+ {2}\[test run after\]/);
  expect(out).toMatch(/src\/cart.js @@ \S+ \S+ {2}\[nothing ran after\]/);
  expect(out).not.toContain("\x1b[");
});

test("shortens hunks unless --full", () => {
  const inputs = loadBriefingInputs(run.repo.dir, {});
  expect(renderShow(inputs)).toContain("+export function formatPrice(cents) {");
  expect(renderShow(inputs, { diff: false })).not.toContain("+export function formatPrice");
});

test("a passing run means less for a file no test goes with", () => {
  const inputs = loadBriefingInputs(run.repo.dir, {});
  const out = renderShow(inputs, { diff: false, ...testFiles(run.repo.dir, inputs) });
  // The subagent's new formatPrice has no test; order.js has the new test,
  // and cart.js is reached through it (the test imports order.js, which
  // imports cart.js).
  expect(out).toMatch(
    /src\/format.js @@ \S+ \S+ \(added\) {2}\[tests passed after, none for this file\]/,
  );
  expect(out).toMatch(/src\/order.js @@ \S+ \S+ {2}\[test run after\]/);
  expect(out).toContain(
    "untested_change  src/format.js: no test added or changed, and no test file uses it",
  );
  expect(out).not.toMatch(/untested_change {2}src\/(?:order|cart).js/);
});

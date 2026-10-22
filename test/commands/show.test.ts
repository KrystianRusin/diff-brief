import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadBriefingInputs } from "../../src/briefing/inputs.js";
import { renderShow } from "../../src/commands/show.js";
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
    "▸ plan step",
    "▸ delegated to a subagent",
    "▸ plan step",
    "▸ plan step",
  ]);
  expect(out).toContain("Fix double discount in src/order.js");
  expect(out).toContain("Run formatter-simulation script on src/cart.js");
  expect(out).not.toContain("\x1b[");
});

test("shortens hunks unless --full", () => {
  const inputs = loadBriefingInputs(run.repo.dir, {});
  expect(renderShow(inputs)).toContain("+export function formatPrice(cents) {");
  expect(renderShow(inputs, { diff: false })).not.toContain("+export function formatPrice");
});

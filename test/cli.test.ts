import { expect, test } from "vitest";
import { buildProgram } from "../src/commands/index.js";

test("registers every v1 command", () => {
  const names = buildProgram().commands.map((c) => c.name());
  expect(names).toEqual(["init", "view", "list", "enrich", "doctor", "hook"]);
});

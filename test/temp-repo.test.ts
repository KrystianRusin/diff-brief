import { afterEach, expect, test } from "vitest";
import { makeTempRepo, type TempRepo } from "./helpers/temp-repo.js";

let repo: TempRepo;
afterEach(() => repo?.cleanup());

test("makeTempRepo commits files and shows working tree changes", () => {
  repo = makeTempRepo();
  repo.write("src/a.ts", "export const a = 1;\n");
  const sha = repo.commit("initial");
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  repo.write("src/a.ts", "export const a = 2;\n");
  expect(repo.git("diff", "--name-only")).toBe("src/a.ts");
});

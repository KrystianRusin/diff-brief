import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { runInit } from "../../src/commands/init.js";
import { createClaudeHeadless } from "../../src/llm/claude-headless.js";
import { makeTempRepo, type TempRepo } from "../helpers/temp-repo.js";

// Calls the real `claude -p`, so opt-in: DIFFBRIEF_IT=1 npx vitest run test/llm
const MODEL = process.env.DIFFBRIEF_IT_MODEL ?? "claude-haiku-5-5";
const SYSTEM = "You answer in as few words as possible.";

describe.skipIf(process.env.DIFFBRIEF_IT !== "1")("claude-headless (live)", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = makeTempRepo();
    repo.write("README.md", "hi\n");
    repo.commit("init");
  });
  afterEach(() => repo.cleanup());

  const sessions = () => {
    const dir = join(repo.dir, ".diffbrief/sessions");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  test("healthcheck passes", async () => {
    const res = await createClaudeHeadless({ model: MODEL, timeoutMs: 60_000 }).healthcheck();
    expect(res, res.detail).toMatchObject({ ok: true });
  }, 90_000);

  test("round-trips a schema'd response", async () => {
    const Answer = z.object({ capital: z.string(), population_millions: z.number() });
    const res = await createClaudeHeadless({ model: MODEL, timeoutMs: 120_000 }).complete({
      system: SYSTEM,
      prompt: "What is the capital of France and its population in millions?",
      schema: Answer,
    });
    expect(res.data?.capital).toMatch(/paris/i);
    expect(res.usage?.outputTokens).toBeGreaterThan(0);
    expect(res.model).toBe(MODEL);
  }, 150_000);

  test("creates no session in a repo with diffbrief hooks installed", async () => {
    const cli = `${process.execPath} --import ${import.meta.resolve("tsx")} ${resolve("src/cli.ts")}`;
    runInit({ cwd: repo.dir, cli });

    // Control: a plain `claude -p` in the repo is recorded, so the hooks work.
    const env = { ...process.env };
    delete env.DIFFBRIEF_DISABLE;
    execFileSync(
      "claude",
      ["-p", "--model", MODEL, "--tools", "", "--no-session-persistence", "--strict-mcp-config"],
      { cwd: repo.dir, env, input: "Say ok.", stdio: ["pipe", "ignore", "inherit"] },
    );
    expect(sessions().length).toBeGreaterThan(0);
    repo.git("clean", "-fdxq", "--", ".diffbrief/sessions");
    expect(sessions()).toEqual([]);

    // Even run from inside the repo (hooks load), DIFFBRIEF_DISABLE keeps it out.
    await createClaudeHeadless({ model: MODEL, timeoutMs: 120_000, cwd: repo.dir }).complete({
      system: SYSTEM,
      prompt: "Say ok.",
    });
    expect(sessions()).toEqual([]);
  }, 300_000);
});

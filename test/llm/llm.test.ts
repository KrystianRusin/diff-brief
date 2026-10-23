import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createFakeProvider,
  getProvider,
  limitConcurrency,
  LlmConfig,
  LlmConfigError,
  LlmError,
  loadLlmConfig,
  promptHash,
  type LlmProvider,
} from "../../src/llm/index.js";
import { createClaudeHeadless } from "../../src/llm/claude-headless.js";
import { extractJson, parseStructured } from "../../src/llm/structured.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "diffbrief-llm-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const Pick = z.object({ color: z.string(), n: z.int() });

describe("structured output", () => {
  test("extracts the first JSON value from prose or a fence", () => {
    expect(extractJson('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"s": "a } brace", "b": [1, {"c": 2}]} trailing')).toEqual({
      s: "a } brace",
      b: [1, { c: 2 }],
    });
    expect(extractJson("{not json} then [1, 2]")).toEqual([1, 2]);
    expect(extractJson("no json here")).toBeUndefined();
  });

  test("prefers the provider's structured value over the text", () => {
    expect(parseStructured(Pick, "junk", { color: "red", n: 1 })).toEqual({
      ok: true,
      data: { color: "red", n: 1 },
    });
    expect(parseStructured(Pick, '{"color": "red", "n": 1}')).toMatchObject({ ok: true });
    const bad = parseStructured(Pick, '{"color": "red", "n": 1.5}');
    expect(bad.ok).toBe(false);
    expect(parseStructured(Pick, "nothing")).toEqual({
      ok: false,
      error: "the reply contained no JSON",
    });
  });
});

describe("config", () => {
  const writeConfig = (config: unknown) => {
    mkdirSync(join(dir, ".diffbrief"), { recursive: true });
    writeFileSync(join(dir, ".diffbrief/config.json"), JSON.stringify(config));
  };

  test("defaults without a config file", () => {
    expect(loadLlmConfig(dir, {})).toEqual({
      provider: "claude-headless",
      model: "claude-opus-5-5",
      concurrency: 3,
      timeoutMs: 120_000,
    });
  });

  test("reads llm and fills the rest with defaults; env overrides provider", () => {
    writeConfig({ llm: { model: "claude-sonnet-5-5", concurrency: 1 }, risk: {} });
    expect(loadLlmConfig(dir, {})).toMatchObject({ model: "claude-sonnet-5-5", concurrency: 1 });
    expect(
      loadLlmConfig(dir, { DIFFBRIEF_LLM_PROVIDER: "fake", DIFFBRIEF_LLM_FIXTURES: "/f.json" }),
    ).toMatchObject({ provider: "fake", fixtures: "/f.json", model: "claude-sonnet-5-5" });
  });

  test("rejects an invalid llm section", () => {
    writeConfig({ llm: { concurrency: 0 } });
    expect(() => loadLlmConfig(dir, {})).toThrow(LlmConfigError);
  });
});

describe("registry", () => {
  test("unknown provider names the known ones", () => {
    expect(() => getProvider(LlmConfig.parse({ provider: "nope" }))).toThrow(
      /unknown llm.provider "nope" \(known: claude-headless, fake\)/,
    );
  });

  test("fake provider loads fixtures from a file", async () => {
    const fixtures = join(dir, "fixtures.json");
    writeFileSync(fixtures, JSON.stringify({ [promptHash("s", "p")]: "hello" }));
    const p = getProvider(LlmConfig.parse({ provider: "fake", fixtures }));
    expect(p.id).toBe("fake");
    expect((await p.complete({ system: "s", prompt: "p" })).text).toBe("hello");
    expect(() => getProvider(LlmConfig.parse({ provider: "fake" }))).toThrow(/fixtures/);
  });
});

describe("fake provider", () => {
  const fake = createFakeProvider({
    [promptHash("sys", "text")]: "plain reply",
    [promptHash("sys", "data")]: { data: { color: "red", n: 3 } },
    [promptHash("sys", "in text")]: 'Here: {"color": "blue", "n": 4}',
    [promptHash("sys", "bad")]: { data: { color: "red" } },
  });

  test("returns canned replies, validated when a schema is given", async () => {
    expect(await fake.complete({ system: "sys", prompt: "text" })).toEqual({
      text: "plain reply",
      model: "fake",
    });
    expect((await fake.complete({ system: "sys", prompt: "data", schema: Pick })).data).toEqual({
      color: "red",
      n: 3,
    });
    expect((await fake.complete({ system: "sys", prompt: "in text", schema: Pick })).data).toEqual({
      color: "blue",
      n: 4,
    });
    await expect(fake.complete({ system: "sys", prompt: "bad", schema: Pick })).rejects.toThrow(
      LlmError,
    );
  });

  test("a miss names the hash to add", async () => {
    await expect(fake.complete({ system: "sys", prompt: "missing" })).rejects.toThrow(
      promptHash("sys", "missing"),
    );
  });
});

describe("limitConcurrency", () => {
  test("keeps at most max calls in flight and runs them all", async () => {
    let active = 0;
    let peak = 0;
    const slow: LlmProvider = {
      id: "slow",
      async complete(req) {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (req.prompt === "fail") throw new Error("boom");
        return { text: req.prompt };
      },
      healthcheck: async () => ({ ok: true, detail: "" }),
    };
    const p = limitConcurrency(slow, 2);
    const prompts = ["a", "b", "fail", "c", "d", "e"];
    const results = await Promise.allSettled(
      prompts.map((prompt) => p.complete({ system: "", prompt })),
    );
    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value.text : "x"))).toEqual([
      "a",
      "b",
      "x",
      "c",
      "d",
      "e",
    ]);
  });
});

// A stand-in `claude` that logs each call and replays scripted envelopes.
function stubClaude(
  replies: unknown[],
  help = "--print --output-format --model --system-prompt --tools --json-schema --strict-mcp-config --no-session-persistence",
) {
  const bin = join(dir, "claude");
  writeFileSync(join(dir, "replies.json"), JSON.stringify(replies));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log(${JSON.stringify(help)}); process.exit(0); }
if (args[0] === "auth") { console.log(process.env.STUB_AUTH || '{"loggedIn":true,"authMethod":"claude.ai"}'); process.exit(0); }
const stdin = fs.readFileSync(0, "utf8");
const calls = fs.existsSync(dir + "/calls.json") ? JSON.parse(fs.readFileSync(dir + "/calls.json", "utf8")) : [];
calls.push({ args, stdin, cwd: process.cwd(), disable: process.env.DIFFBRIEF_DISABLE, maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS });
fs.writeFileSync(dir + "/calls.json", JSON.stringify(calls));
const reply = JSON.parse(fs.readFileSync(dir + "/replies.json", "utf8"))[calls.length - 1];
if (reply === "hang") setTimeout(() => {}, 60000);
else if (typeof reply === "string") { process.stderr.write(reply); process.exit(2); }
else { console.log(JSON.stringify(reply)); process.exit(reply.is_error ? 1 : 0); }
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

type Call = { args: string[]; stdin: string; cwd: string; disable?: string; maxTokens?: string };
const calls = (): Call[] => JSON.parse(readFileSync(join(dir, "calls.json"), "utf8"));
const flag = (c: Call | undefined, name: string) => c?.args[c.args.indexOf(name) + 1];

const ok = (extra: object) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 10,
    output_tokens: 7,
  },
  modelUsage: { "claude-opus-5-5": {} },
  ...extra,
});

describe("claude-headless", () => {
  const provider = (bin: string, timeoutMs = 10_000) =>
    createClaudeHeadless({ model: "claude-opus-5-5", timeoutMs, bin });

  test("plain call: flags, prompt on stdin, temp cwd, recursion guard", async () => {
    const bin = stubClaude([ok({ result: "hi there" })]);
    const res = await provider(bin).complete({
      system: "be brief",
      prompt: "say hi",
      maxTokens: 500,
    });
    expect(res).toEqual({
      text: "hi there",
      usage: { inputTokens: 112, outputTokens: 7 },
      model: "claude-opus-5-5",
    });
    const c = calls()[0]!;
    expect(c.stdin).toBe("say hi");
    expect(flag(c, "--system-prompt")).toBe("be brief");
    expect(flag(c, "--model")).toBe("claude-opus-5-5");
    expect(flag(c, "--output-format")).toBe("json");
    expect(flag(c, "--tools")).toBe("");
    expect(c.args).toContain("--no-session-persistence");
    expect(c.args).toContain("--strict-mcp-config");
    expect(c.args).not.toContain("--json-schema");
    expect(c.cwd).toMatch(/diffbrief-llm-/);
    expect(c.cwd).not.toBe(process.cwd());
    expect(c.disable).toBe("1");
    expect(c.maxTokens).toBe("500");
  });

  test("schema call passes the JSON Schema and returns structured_output", async () => {
    const bin = stubClaude([ok({ result: "", structured_output: { color: "teal", n: 7 } })]);
    const res = await provider(bin).complete({ system: "s", prompt: "pick", schema: Pick });
    expect(res.data).toEqual({ color: "teal", n: 7 });
    const schema = JSON.parse(flag(calls()[0], "--json-schema") ?? "");
    expect(schema).toMatchObject({ type: "object", required: ["color", "n"] });
    expect(schema).not.toHaveProperty("$schema");
  });

  test("retries once with the validation error, then gives up", async () => {
    const Even = Pick.refine((v) => v.n % 2 === 0, "n must be even");
    const bin = stubClaude([
      ok({ structured_output: { color: "a", n: 1 } }),
      ok({ structured_output: { color: "b", n: 2 } }),
    ]);
    const res = await provider(bin).complete({ system: "s", prompt: "pick", schema: Even });
    expect(res.data).toEqual({ color: "b", n: 2 });
    expect(calls()[1]?.stdin).toMatch(
      /^pick\n\nYour previous reply did not match[\s\S]*n must be even/,
    );

    rmSync(join(dir, "calls.json"));
    const bin2 = stubClaude([ok({ result: "nope" }), ok({ result: '{"color": "c", "n": 3}' })]);
    await expect(
      provider(bin2).complete({ system: "s", prompt: "pick", schema: Even }),
    ).rejects.toThrow(/after a retry[\s\S]*n must be even/);
    expect(calls()).toHaveLength(2);
  });

  test("falls back to JSON in the result text", async () => {
    const bin = stubClaude([ok({ result: 'ok: {"color": "red", "n": 1}' })]);
    const res = await provider(bin).complete({ system: "s", prompt: "pick", schema: Pick });
    expect(res.data).toEqual({ color: "red", n: 1 });
  });

  test("errors: error envelope, no envelope, timeout, missing binary", async () => {
    const bin = stubClaude([
      ok({ is_error: true, result: "There's an issue with the selected model" }),
      "unknown option --json-schema",
      "hang",
    ]);
    const p = provider(bin, 1000);
    await expect(p.complete({ system: "s", prompt: "x" })).rejects.toThrow(
      /claude: There's an issue with the selected model/,
    );
    await expect(p.complete({ system: "s", prompt: "x" })).rejects.toThrow(
      /exited 2 without a JSON result: unknown option --json-schema/,
    );
    await expect(p.complete({ system: "s", prompt: "x" })).rejects.toThrow(
      /timed out after 1000 ms/,
    );
    await expect(
      provider(join(dir, "no-such-claude")).complete({ system: "s", prompt: "x" }),
    ).rejects.toThrow(/not found/);
  });

  test("healthcheck reports version, missing flags and auth", async () => {
    expect(await provider(stubClaude([])).healthcheck()).toEqual({
      ok: true,
      detail: "claude 9.9.9, model claude-opus-5-5, auth: claude.ai",
    });
    expect(await provider(stubClaude([], "--print --model")).healthcheck()).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/lacks --output-format, --system-prompt.*update Claude Code/),
    });
    process.env.STUB_AUTH = '{"loggedIn":false}';
    try {
      expect(await provider(stubClaude([])).healthcheck()).toMatchObject({
        ok: false,
        detail: expect.stringMatching(/not logged in/),
      });
    } finally {
      delete process.env.STUB_AUTH;
    }
    expect(await provider(join(dir, "no-such-claude")).healthcheck()).toMatchObject({ ok: false });
  });
});

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseStructured, retryPrompt, toJsonSchema } from "./structured.js";
import { LlmError, type CompleteResult, type LlmProvider, type Usage } from "./types.js";

// Runs `claude -p`: no API key of its own, it uses whatever auth Claude Code
// already has.

export type ClaudeHeadlessOptions = {
  model: string;
  timeoutMs: number;
  bin?: string; // default "claude" on PATH
  // Default: a fresh empty temp dir per call, so the repo's CLAUDE.md and
  // project hooks never load. Tests point it at a repo to check the env guard.
  cwd?: string;
};

// Flags complete() relies on; healthcheck() looks for each in `claude --help`.
const REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--model",
  "--system-prompt",
  "--tools",
  "--json-schema",
  "--strict-mcp-config",
  "--no-session-persistence",
];

const HEALTHCHECK_TIMEOUT_MS = 30_000;

// The part of the `--output-format json` result we read.
const Envelope = z
  .object({
    is_error: z.boolean().optional(),
    subtype: z.string().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .loose()
      .optional(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
type Envelope = z.infer<typeof Envelope>;

export function createClaudeHeadless(opts: ClaudeHeadlessOptions): LlmProvider {
  const bin = opts.bin ?? "claude";

  async function call(
    system: string,
    prompt: string,
    jsonSchema: Record<string, unknown> | undefined,
    maxTokens: number | undefined,
    timeoutMs: number,
  ): Promise<Envelope> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      opts.model,
      "--system-prompt",
      system,
      // Tools off: one answer, no agent loop. The schema's own answer turn
      // still runs, which is why there's no --max-turns 1.
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []),
    ];
    const env = maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {};
    const out = await run(bin, args, prompt, { cwd: opts.cwd, env, timeoutMs });

    let envelope: Envelope;
    try {
      envelope = Envelope.parse(JSON.parse(out.stdout));
    } catch {
      throw new LlmError(`claude exited ${out.code} without a JSON result: ${tail(out)}`);
    }
    if (envelope.is_error) {
      throw new LlmError(`claude: ${envelope.result || envelope.subtype || tail(out)}`);
    }
    return envelope;
  }

  return {
    id: "claude-headless",

    async complete(req) {
      const timeoutMs = req.timeoutMs ?? opts.timeoutMs;
      const jsonSchema = req.schema ? toJsonSchema(req.schema) : undefined;
      let prompt = req.prompt;
      // One retry with the validation error appended. The CLI already checks
      // the JSON Schema, so this catches zod refinements it can't express.
      for (let attempt = 0; ; attempt++) {
        const envelope = await call(req.system, prompt, jsonSchema, req.maxTokens, timeoutMs);
        const result = toResult<never>(envelope);
        if (!req.schema) return result;
        const parsed = parseStructured(req.schema, result.text, envelope.structured_output);
        if (parsed.ok) return { ...result, data: parsed.data };
        if (attempt > 0) {
          throw new LlmError(`reply did not match the schema after a retry:\n${parsed.error}`);
        }
        prompt = retryPrompt(req.prompt, parsed.error);
      }
    },

    async healthcheck() {
      const opt = { cwd: opts.cwd, env: {}, timeoutMs: HEALTHCHECK_TIMEOUT_MS };
      try {
        const version = (await run(bin, ["--version"], "", opt)).stdout.trim().split(/\s/)[0];
        const help = (await run(bin, ["--help"], "", opt)).stdout;
        const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`${f}\\b`).test(help));
        if (missing.length > 0) {
          return {
            ok: false,
            detail: `claude ${version} lacks ${missing.join(", ")}; update Claude Code`,
          };
        }
        const auth = await authStatus(bin, opt);
        if (auth === false) {
          return {
            ok: false,
            detail: `claude ${version} is not logged in; run \`claude auth login\``,
          };
        }
        return {
          ok: true,
          detail: `claude ${version}, model ${opts.model}${auth ? `, ${auth}` : ""}`,
        };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function toResult<T>(envelope: Envelope): CompleteResult<T> {
  const u = envelope.usage;
  const usage: Usage | undefined = u && {
    // Cached prompt tokens are still input the call consumed.
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
  const model = Object.keys(envelope.modelUsage ?? {})[0];
  return {
    text: envelope.result ?? "",
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
  };
}

// false when logged out, a short description when logged in, undefined when
// this CLI can't tell us.
async function authStatus(bin: string, opt: RunOptions): Promise<string | false | undefined> {
  try {
    const out = await run(bin, ["auth", "status"], "", opt);
    const status = JSON.parse(out.stdout) as { loggedIn?: unknown; authMethod?: unknown };
    if (status.loggedIn === false) return false;
    return typeof status.authMethod === "string" ? `auth: ${status.authMethod}` : undefined;
  } catch {
    return undefined;
  }
}

type RunOptions = { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number };
type RunOutput = { stdout: string; stderr: string; code: number | null };

function run(bin: string, args: string[], input: string, opt: RunOptions): Promise<RunOutput> {
  const cwd = opt.cwd ?? mkdtempSync(join(tmpdir(), "diffbrief-llm-"));
  const cleanup = () => {
    if (!opt.cwd) rmSync(cwd, { recursive: true, force: true });
  };

  return new Promise<RunOutput>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      // DIFFBRIEF_DISABLE: if diffbrief hooks load anyway (user-level
      // settings, or a cwd override), they record nothing for this call.
      env: { ...process.env, ...opt.env, DIFFBRIEF_DISABLE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new LlmError(`claude timed out after ${opt.timeoutMs} ms`));
    }, opt.timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new LlmError(
          err.code === "ENOENT"
            ? `\`${bin}\` not found; install Claude Code or set llm.provider in .diffbrief/config.json`
            : `could not run ${bin}: ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    // The child may exit before reading stdin (bad flag); the close handler
    // reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }).finally(cleanup);
}

function tail(out: RunOutput): string {
  const text = (out.stderr.trim() || out.stdout.trim()).slice(-500);
  return text || "(no output)";
}

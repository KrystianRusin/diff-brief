import { readFileSync } from "node:fs";
import { z } from "zod";
import { configPath } from "../store/layout.js";

// What `init` writes. Accuracy over latency: enrich is off the critical path.
export const DEFAULT_LLM_CONFIG = {
  provider: "claude-headless",
  model: "claude-opus-5-5",
  concurrency: 3,
};

export const LlmConfig = z.object({
  provider: z.string().min(1).default(DEFAULT_LLM_CONFIG.provider),
  model: z.string().min(1).default(DEFAULT_LLM_CONFIG.model),
  concurrency: z.int().positive().default(DEFAULT_LLM_CONFIG.concurrency),
  timeoutMs: z.int().positive().default(120_000),
  // fake provider: JSON file of canned replies.
  fixtures: z.string().optional(),
});
export type LlmConfig = z.infer<typeof LlmConfig>;

const ConfigFile = z.object({ llm: LlmConfig.optional() }).loose();

export class LlmConfigError extends Error {}

// The "llm" section of .diffbrief/config.json with defaults filled in.
// DIFFBRIEF_LLM_PROVIDER and DIFFBRIEF_LLM_FIXTURES override it, for tests.
export function loadLlmConfig(root: string, env: NodeJS.ProcessEnv = process.env): LlmConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(configPath(root), "utf8"));
  } catch {
    // no config: defaults
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new LlmConfigError(`config.json: invalid "llm": ${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data.llm ?? LlmConfig.parse({});
  return {
    ...config,
    ...(env.DIFFBRIEF_LLM_PROVIDER ? { provider: env.DIFFBRIEF_LLM_PROVIDER } : {}),
    ...(env.DIFFBRIEF_LLM_FIXTURES ? { fixtures: env.DIFFBRIEF_LLM_FIXTURES } : {}),
  };
}

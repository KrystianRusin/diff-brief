import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseStructured } from "./structured.js";
import { LlmError, type LlmProvider } from "./types.js";

// Canned replies for tests, so CI never calls a model. A reply is the raw
// text, or { text?, data? } where data stands in for structured output.
export type FakeReply = string | { text?: string; data?: unknown };
export type FakeFixtures = Record<string, FakeReply>; // keyed by promptHash()

export function promptHash(system: string, prompt: string): string {
  return createHash("sha256").update(system).update("\0").update(prompt).digest("hex");
}

export function createFakeProvider(fixtures: FakeFixtures): LlmProvider {
  return {
    id: "fake",

    async complete(req) {
      const key = promptHash(req.system, req.prompt);
      const reply = fixtures[key];
      if (reply === undefined) {
        // Says exactly which fixture to add.
        const start = req.prompt.slice(0, 80).replace(/\s+/g, " ");
        throw new LlmError(`fake provider: no fixture for ${key} (prompt: "${start}…")`);
      }
      const { text = "", data } = typeof reply === "string" ? { text: reply } : reply;
      if (!req.schema) return { text, model: "fake" };
      const parsed = parseStructured(req.schema, text, data);
      if (!parsed.ok) throw new LlmError(`fake provider: fixture ${key}: ${parsed.error}`);
      return { text, data: parsed.data, model: "fake" };
    },

    async healthcheck() {
      return { ok: true, detail: `fake provider, ${Object.keys(fixtures).length} fixtures` };
    },
  };
}

export function loadFakeFixtures(path: string): FakeFixtures {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FakeFixtures;
  } catch (err) {
    throw new LlmError(
      `fake provider: can't read fixtures ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

import { createClaudeHeadless } from "./claude-headless.js";
import type { LlmConfig } from "./config.js";
import { createFakeProvider, loadFakeFixtures } from "./fake.js";
import { LlmError, type LlmProvider } from "./types.js";

export { DEFAULT_LLM_CONFIG, LlmConfig, LlmConfigError, loadLlmConfig } from "./config.js";
export { createFakeProvider, promptHash, type FakeFixtures, type FakeReply } from "./fake.js";
export {
  LlmError,
  type CompleteRequest,
  type CompleteResult,
  type LlmProvider,
  type Usage,
} from "./types.js";

// Adding a provider: one file plus one entry here.
const registry: Record<string, (config: LlmConfig) => LlmProvider> = {
  "claude-headless": (c) => createClaudeHeadless({ model: c.model, timeoutMs: c.timeoutMs }),
  fake: (c) => {
    if (!c.fixtures)
      throw new LlmError("fake provider needs llm.fixtures or DIFFBRIEF_LLM_FIXTURES");
    return createFakeProvider(loadFakeFixtures(c.fixtures));
  },
};

export const providerIds = Object.keys(registry);

export function getProvider(config: LlmConfig): LlmProvider {
  const make = registry[config.provider];
  if (!make) {
    throw new LlmError(
      `unknown llm.provider "${config.provider}" (known: ${providerIds.join(", ")})`,
    );
  }
  return limitConcurrency(make(config), config.concurrency);
}

// At most `max` complete() calls in flight; the rest wait in order.
export function limitConcurrency(provider: LlmProvider, max: number): LlmProvider {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    id: provider.id,
    healthcheck: () => provider.healthcheck(),
    async complete(req) {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      try {
        return await provider.complete(req);
      } finally {
        // Hand the slot straight to the next caller, or free it.
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

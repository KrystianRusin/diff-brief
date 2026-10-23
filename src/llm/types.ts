import type { ZodType } from "zod";

export type CompleteRequest<T> = {
  system: string;
  prompt: string;
  // Structured output: the reply is validated against it and returned as `data`.
  schema?: ZodType<T>;
  maxTokens?: number;
  timeoutMs?: number;
};

export type Usage = { inputTokens?: number; outputTokens?: number };

export type CompleteResult<T> = { text: string; data?: T; usage?: Usage; model?: string };

// Every model call in diffbrief goes through this. Provider-specific code
// stays in the provider's own file.
export interface LlmProvider {
  id: string;
  complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>>;
  // For `diffbrief doctor`.
  healthcheck(): Promise<{ ok: boolean; detail: string }>;
}

export class LlmError extends Error {}

import { z, type ZodType } from "zod";

// Schema sent to the model. "input" because the model's JSON is what the
// schema parses, before any transforms. No "$schema": `claude --json-schema`
// rejects the draft 2020-12 meta-schema URL zod emits.
export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest;
}

// First balanced JSON object or array in free text, e.g. a reply wrapped in a
// ``` fence or a sentence. Strings are skipped so braces inside them don't count.
export function extractJson(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const end = matchingClose(text, start);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // not JSON after all; keep scanning
    }
  }
  return undefined;
}

function matchingClose(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

// `value` is the provider's own structured output when it has one; otherwise
// the JSON is pulled out of the reply text.
export function parseStructured<T>(schema: ZodType<T>, text: string, value?: unknown): Parsed<T> {
  const raw = value !== undefined ? value : extractJson(text);
  if (raw === undefined) return { ok: false, error: "the reply contained no JSON" };
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: z.prettifyError(parsed.error) };
}

export function retryPrompt(prompt: string, error: string): string {
  return (
    `${prompt}\n\nYour previous reply did not match the required schema:\n${error}\n` +
    "Reply again with only JSON that matches it."
  );
}

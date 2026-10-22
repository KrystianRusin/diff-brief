// The capture hook's scratch state, one per session in state.json. Losing it
// only costs external_change precision and fallback intents.

// Where one transcript walk has got to, and the context at that point in
// the conversation. Walks resume from `offset` on the next pass.
export type Walk = {
  offset: number;
  // Assistant text since the last tool result. It narrates the tool calls
  // that follow it, including several in parallel.
  narration?: { text: string; msgIds: string[]; intentId?: string; endedByToolUse: boolean };
  // Description of the latest Bash call in the current batch.
  batchCommand?: { text: string; intentId?: string };
  // A tool result came back since the last assistant block, so the next
  // assistant block starts a new batch.
  sawResult: boolean;
  // The user's (or, for a subagent, the parent's) latest request.
  prompt?: string;
  // Tool calls waiting for their result.
  pending: Record<string, { name: string; input: Record<string, unknown>; ts: string }>;
};

export type CaptureState = {
  started: boolean;
  start?: { ts: string; base_sha: string; branch?: string; ticket?: string; cwd: string };
  // Last known content hash per repo-relative path (null = absent).
  lastHash: Record<string, string | null>;
  // Dirty files at session start, so pre-existing changes aren't reported as
  // external.
  startDirty: Record<string, string | null>;
  // Edit ids written but not yet linked to an intent, with their agent key.
  unresolved: Record<string, string>;
  // Intents resolved from the transcript before the edit hook fired.
  links: Record<string, { intent_id: string; msg_ref?: string; plan_step?: string }>;
  bashFailures: Record<string, { exit: number; duration_ms: number }>;
  // Bash tool_use id → edits it made, waiting for the walk to explain them.
  bashEdits: Record<string, string[]>;
  // Task in progress, as of the furthest point any walk has reached.
  plan: { current?: string };
  // Latest prompt from UserPromptSubmit, for edits no walk explains.
  lastPrompt?: string;
  // Prompt text → the fallback intent created for it.
  promptIntents: Record<string, string>;
  // Subagent prompt text → its delegation intent. Either side can see it
  // first; `emitted` once the intent event is written.
  delegations: Record<string, { id: string; emitted: boolean }>;
  walks: Record<string, Walk>;
  // Subagent id → its transcript path, once known.
  agents: Record<string, string>;
  counters: { m: number; i: number };
};

export function emptyState(): CaptureState {
  return {
    started: false,
    lastHash: {},
    startDirty: {},
    unresolved: {},
    links: {},
    bashFailures: {},
    bashEdits: {},
    plan: {},
    promptIntents: {},
    delegations: {},
    walks: {},
    agents: {},
    counters: { m: 0, i: 0 },
  };
}

// Fill in anything missing from an older or partly corrupt state file.
export function normalizeState(raw: unknown): CaptureState {
  const base = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const merged = { ...base, ...(raw as Partial<CaptureState>) };
  for (const key of Object.keys(base) as (keyof CaptureState)[]) {
    const want = base[key];
    const got = merged[key];
    if (want !== undefined && typeof got !== typeof want) {
      (merged as Record<string, unknown>)[key] = want;
    }
  }
  return merged;
}

export function newWalk(): Walk {
  return { offset: 0, sawResult: false, pending: {} };
}

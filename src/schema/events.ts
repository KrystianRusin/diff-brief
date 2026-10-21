import { z } from "zod";
import { ContentHash, GitSha, Timestamp, Version } from "./common.js";
import { migrateEvent } from "./migrate.js";
import { assertReadableVersion } from "./version.js";

// One line of .diffbrief/sessions/<id>/events.jsonl. Ids (intent, message,
// edit, command) are strings and unique within a session; DB-09 namespaces
// them by session when merging.

const base = { v: Version, ts: Timestamp };

// Subagent that produced the event; absent means the main agent.
const agent = { agent_id: z.string().optional() };

export const SessionStartEvent = z.object({
  ...base,
  type: z.literal("session_start"),
  agent: z.string(),
  session_id: z.string(),
  base_sha: GitSha,
  branch: z.string().optional(), // absent on detached HEAD
  ticket: z.string().optional(),
  prompt: z.string().optional(),
  cwd: z.string(),
});

export const PromptEvent = z.object({
  ...base,
  type: z.literal("prompt"),
  text: z.string(),
});

export const IntentEvent = z.object({
  ...base,
  ...agent,
  type: z.literal("intent"),
  id: z.string(),
  why: z.string(),
  serves: z.string().optional(),
  // narration and plan_step come from the agent; command_description (a Bash
  // tool's description) and prompt (the user's request) are fallbacks for
  // edits the agent didn't explain.
  source: z.enum(["narration", "plan_step", "command_description", "prompt"]),
  msg_ref: z.string().optional(),
});

export const AgentMessageEvent = z.object({
  ...base,
  ...agent,
  type: z.literal("agent_message"),
  id: z.string(),
  text: z.string(),
});

export const ReadEvent = z.object({
  ...base,
  ...agent,
  type: z.literal("read"),
  path: z.string(),
});

// Hashes are null when the file did not exist on that side (created / deleted).
export const EditEvent = z.object({
  ...base,
  ...agent,
  type: z.literal("edit"),
  id: z.string(),
  path: z.string(),
  old_path: z.string().optional(),
  tool: z.string(),
  before_hash: ContentHash.nullable(),
  after_hash: ContentHash.nullable(),
  intent_id: z.string().optional(),
  msg_ref: z.string().optional(),
  too_large: z.boolean().optional(), // hashed but no blob stored
});

// Attaches an intent to an edit written earlier. Adapters that only learn the
// reason after the edit (Claude Code's transcript lags its hooks) emit this
// instead of rewriting the append-only log. Readers apply it onto the edit;
// a later link for the same edit wins.
export const EditLinkEvent = z.object({
  ...base,
  type: z.literal("edit_link"),
  edit_id: z.string(),
  intent_id: z.string(),
  msg_ref: z.string().optional(),
});

// The file changed between agent edits: manual edit, formatter, codegen.
export const ExternalChangeEvent = z.object({
  ...base,
  type: z.literal("external_change"),
  path: z.string(),
  before_hash: ContentHash.nullable(),
  after_hash: ContentHash.nullable(),
});

export const CommandEvent = z.object({
  ...base,
  ...agent,
  type: z.literal("command"),
  id: z.string(),
  cmd: z.string(),
  description: z.string().optional(), // agent-written, before the command ran
  exit: z.number().int(),
  duration_ms: z.number().int().nonnegative(),
  kind: z.enum(["test", "build", "lint", "other"]).optional(),
});

export const SessionEndEvent = z.object({
  ...base,
  type: z.literal("session_end"),
  transcript_path: z.string().optional(),
  reason: z.string().optional(),
});

export const Event = z.discriminatedUnion("type", [
  SessionStartEvent,
  PromptEvent,
  IntentEvent,
  AgentMessageEvent,
  ReadEvent,
  EditEvent,
  EditLinkEvent,
  ExternalChangeEvent,
  CommandEvent,
  SessionEndEvent,
]);

export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export function parseEvent(raw: unknown): Event {
  assertReadableVersion(raw, "Session event");
  return Event.parse(migrateEvent(raw));
}

export function parseEventLine(line: string): Event {
  return parseEvent(JSON.parse(line));
}

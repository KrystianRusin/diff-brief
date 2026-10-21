import { fs } from "../../store/builtins.js";
import { agent, type Session } from "./session.js";
import { newWalk, type Walk } from "./state.js";

// Reads a Claude Code transcript forward from where the last pass stopped and
// turns it into events: agent text, reads, commands, and the intent for each
// edit. Walking in order means each edit gets the narration, plan step, and
// Bash description that were current when the agent made it.
//
// The transcript lags the hooks (DB-04), so an edit's tool_use may show up
// in a later pass than its PostToolUse. Session.link handles either order.

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type Entry = {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: string | Block[] };
};

// agentId set = a subagent's own transcript.
export function walkTranscript(s: Session, path: string, agentId?: string): void {
  let walk = s.state.walks[path] ?? newWalk();
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch {
    return; // not written yet
  }
  let text: string;
  try {
    const size = fs.fstatSync(fd).size;
    // Shrunk: rewritten under us, start over.
    if (size < walk.offset) walk = newWalk();
    if (size === walk.offset) return;
    const buf = Buffer.alloc(size - walk.offset);
    fs.readSync(fd, buf, 0, buf.length, walk.offset);
    // Only complete lines; a partial last line is picked up next pass.
    const end = buf.lastIndexOf(10);
    if (end === -1) return;
    text = buf.subarray(0, end).toString("utf8");
    walk.offset += end + 1;
  } finally {
    fs.closeSync(fd);
  }
  s.state.walks[path] = walk;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    visit(s, walk, entry, agentId);
  }
}

function visit(s: Session, walk: Walk, entry: Entry, agentId: string | undefined): void {
  // Older Claude Code versions inlined subagent turns in the main transcript.
  if (entry.isSidechain && !agentId) return;
  if (entry.isMeta) return;
  const ts = entry.timestamp ?? s.now();
  const content = entry.message?.content;

  if (entry.type === "user") {
    if (typeof content === "string") return onPrompt(walk, content);
    if (!Array.isArray(content)) return;
    const typed = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .filter((t) => !t.trimStart().startsWith("<")); // system reminders, command tags
    if (typed.length) onPrompt(walk, typed.join("\n\n"));
    for (const b of content) if (b.type === "tool_result") onResult(s, walk, b, ts, agentId);
    return;
  }

  if (entry.type !== "assistant" || !Array.isArray(content)) return;
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") onText(s, walk, b.text, ts, agentId);
    else if (b.type === "tool_use") onToolUse(s, walk, b, ts, agentId);
    // Thinking blocks are empty (signature only), nothing to take from them.
  }
}

function onPrompt(walk: Walk, text: string): void {
  if (!text.trim() || text.trimStart().startsWith("<")) return;
  walk.prompt = text;
  walk.narration = undefined;
  walk.batchCommand = undefined;
}

// First assistant block after tool results.
function startBatchIfNeeded(walk: Walk): void {
  if (!walk.sawResult) return;
  walk.sawResult = false;
  walk.narration = undefined;
  walk.batchCommand = undefined;
}

function onText(s: Session, walk: Walk, text: string, ts: string, agentId?: string): void {
  if (!text.trim()) return;
  startBatchIfNeeded(walk);
  // Text after a tool call narrates what comes next, not what came before.
  if (!walk.narration || walk.narration.endedByToolUse) {
    walk.narration = { text: "", msgIds: [], endedByToolUse: false };
  }
  const id = s.nextId("m");
  s.emit({ v: 1, type: "agent_message", ts, id, text, ...agent(agentId) });
  walk.narration.text += (walk.narration.text ? "\n\n" : "") + text;
  walk.narration.msgIds.push(id);
}

function onToolUse(s: Session, walk: Walk, b: Block, ts: string, agentId?: string): void {
  startBatchIfNeeded(walk);
  if (walk.narration) walk.narration.endedByToolUse = true;
  const id = b.id;
  const name = b.name ?? "";
  const input = b.input ?? {};
  if (!id) return;

  if (EDIT_TOOLS.has(name)) {
    resolveEdit(s, walk, id, ts, agentId);
  } else if (name === "Bash") {
    if (typeof input.description === "string" && input.description.trim()) {
      walk.batchCommand = { text: input.description };
    }
    walk.pending[id] = { name, input, ts };
  } else if (READ_TOOLS.has(name)) {
    walk.pending[id] = { name, input, ts };
  } else if (name === "TaskUpdate") {
    const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
    if (!taskId) return;
    if (input.status === "in_progress") s.state.plan.current = taskId;
    else if (s.state.plan.current === taskId) s.state.plan.current = undefined;
  }
}

// Intent sources in priority order (DB-04): narration, plan step, the batch's
// Bash description, the prompt.
function resolveEdit(s: Session, walk: Walk, editId: string, ts: string, agentId?: string): void {
  const n = walk.narration;
  if (n) {
    const msgRef = n.msgIds[n.msgIds.length - 1];
    if (!n.intentId) {
      n.intentId = s.nextId("i");
      s.emit({
        v: 1,
        type: "intent",
        ts,
        id: n.intentId,
        why: n.text,
        source: "narration",
        ...(msgRef ? { msg_ref: msgRef } : {}),
        ...agent(agentId),
      });
    }
    return s.link(editId, n.intentId, msgRef, ts);
  }
  if (s.state.plan.current) return s.link(editId, `p${s.state.plan.current}`, undefined, ts);

  const c = walk.batchCommand;
  if (c) {
    if (!c.intentId) {
      c.intentId = s.nextId("i");
      s.emit({
        v: 1,
        type: "intent",
        ts,
        id: c.intentId,
        why: c.text,
        source: "command_description",
        ...agent(agentId),
      });
    }
    return s.link(editId, c.intentId, undefined, ts);
  }

  const prompt = walk.prompt ?? s.state.lastPrompt;
  if (prompt) s.link(editId, s.promptIntent(prompt, agentId, ts), undefined, ts);
  // Otherwise left unresolved; SessionEnd falls back to the last prompt.
}

function onResult(s: Session, walk: Walk, b: Block, ts: string, agentId?: string): void {
  walk.sawResult = true;
  walk.narration = undefined;
  const id = b.tool_use_id;
  if (!id) return;
  const call = walk.pending[id];
  if (!call) return;
  delete walk.pending[id];

  if (call.name === "Bash") {
    const failure = s.state.bashFailures[id];
    delete s.state.bashFailures[id];
    const cmd = typeof call.input.command === "string" ? call.input.command : "";
    const description =
      typeof call.input.description === "string" ? call.input.description : undefined;
    const elapsed = Math.round(Date.parse(ts) - Date.parse(call.ts));
    s.emit({
      v: 1,
      type: "command",
      ts: call.ts,
      id,
      cmd,
      ...(description ? { description } : {}),
      // PostToolUse means exit 0; non-zero comes from PostToolUseFailure, or
      // the transcript's "Exit code N" when that hook didn't fire.
      exit: failure?.exit ?? (b.is_error ? parseExit(resultText(b.content)) : 0),
      duration_ms: failure?.duration_ms ?? (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0),
      kind: commandKind(cmd),
      ...agent(agentId),
    });
    return;
  }

  if (b.is_error) return; // failed reads (missing file) aren't context
  const path = readPath(s, call.name, call.input);
  if (path) s.emit({ v: 1, type: "read", ts: call.ts, path, ...agent(agentId) });
}

function readPath(s: Session, tool: string, input: Record<string, unknown>): string | null {
  if (tool === "Read") return s.repoPath(input.file_path);
  const dir = input.path === undefined ? "." : s.repoPath(input.path);
  if (dir === null) return null;
  if (tool === "Glob" && typeof input.pattern === "string") {
    return dir === "." ? input.pattern : `${dir}/${input.pattern}`;
  }
  return dir;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : ""))
    .join("\n");
}

// "Exit code 3" → 3. Anything else (interrupted, rejected before running) → -1.
export function parseExit(error: string): number {
  const m = /^Exit code (\d+)/.exec(error.trim());
  return m ? Number(m[1]) : -1;
}

type CommandKind = "test" | "build" | "lint" | "other";

// Matched against tools and package scripts, not bare words, so `ls test/`
// isn't a test run.
const script = (names: string) => new RegExp(`\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?(${names})\\b`);
const KINDS: [CommandKind, RegExp[]][] = [
  [
    "test",
    [
      script("test"),
      /\b(jest|vitest|mocha|pytest|rspec|go test|cargo test|node --test|make test)\b/,
    ],
  ],
  [
    "lint",
    [
      script("lint|typecheck"),
      /\b(eslint|prettier|ruff|flake8|mypy|clippy|golangci-lint|tsc --noEmit)\b/,
    ],
  ],
  [
    "build",
    [script("build"), /\b(tsc|tsup|webpack|vite build|cargo build|go build|gradle|mvn|make)\b/],
  ],
];

export function commandKind(cmd: string): CommandKind {
  for (const [kind, patterns] of KINDS) if (patterns.some((re) => re.test(cmd))) return kind;
  return "other";
}

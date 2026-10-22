import { basename, dirname, join } from "node:path";
import { fs } from "../../store/builtins.js";
import { assertSafeId, configPath, STORE_DIR } from "../../store/layout.js";
import { appendLog, readState, writeState } from "../../store/sessions.js";
import { currentBranch, dirtyPaths, findGitRoot, headContents, headSha } from "./git.js";
import { agent, readIfExists, Session, snapshot, type Snapshot } from "./session.js";
import { normalizeState } from "./state.js";
import { EDIT_TOOLS, flushDelegations, parseExit, walkTranscript } from "./transcript.js";

// Translates one Claude Code hook payload into events.jsonl lines and blobs
// (DB-05). Only translates: no model calls, no network.

export type Payload = Record<string, unknown>;
export type CaptureOptions = { now?: () => string };

const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
// Hashing every dirty file (at session start, or to find what a command
// changed) is skipped past this; a huge dirty tree is usually an unignored
// build directory.
const MAX_START_DIRTY = 2000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function capture(payload: Payload, opts: CaptureOptions = {}): void {
  const cwd = str(payload.cwd) ?? process.cwd();
  const root = findGitRoot(cwd);
  if (!root) return;
  try {
    const sessionId = str(payload.session_id);
    if (!sessionId) throw new Error("payload has no session_id");
    assertSafeId(sessionId, "session");
    const state = normalizeState(readState(root, sessionId));
    const s = new Session(root, sessionId, state, opts.now ?? (() => new Date().toISOString()));
    dispatch(s, payload, cwd);
    writeState(root, sessionId, state);
  } catch (err) {
    const event = str(payload.hook_event_name) ?? "?";
    appendLog(root, "hook", `${event}: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  }
}

function dispatch(s: Session, p: Payload, cwd: string): void {
  const event = str(p.hook_event_name);
  if (event === "SessionStart") return sessionStart(s, cwd);

  const prompt = event === "UserPromptSubmit" ? str(p.prompt) : undefined;
  const wasStarted = s.state.started;
  if (!ensureStarted(s, cwd, prompt)) return;

  const transcript = str(p.transcript_path);
  const agentId = str(p.agent_id);
  if (agentId && !(agentId in s.state.agents)) s.state.agents[agentId] = "";

  switch (event) {
    case "UserPromptSubmit":
      // Whatever changed while the agent was idle is the user's, not the
      // next command's.
      if (wasStarted) externalChanges(s, s.now());
      if (prompt && wasStarted) s.emit({ v: 1, type: "prompt", ts: s.now(), text: prompt });
      if (prompt) s.state.lastPrompt = prompt;
      return;
    case "PostToolUse":
      return edit(s, p, agentId);
    case "PostToolUseFailure":
      return bashFailure(s, p);
    case "PostToolBatch":
      // Before the walk, so the walk finds the Bash calls' edits to explain.
      bashEdits(s, p, agentId);
      return pass(s, transcript, agentId ? [agentId] : []);
    case "TaskCreated":
      return taskCreated(s, p, agentId);
    case "SubagentStop": {
      const path = str(p.agent_transcript_path);
      if (agentId && path) s.state.agents[agentId] = path;
      return pass(s, transcript, agentId ? [agentId] : []);
    }
    case "TaskCompleted":
      return; // registered by older installs; the walk handles completion
    case "Stop":
      // PostToolBatch keeping the transcript current is observed, not
      // documented, so every turn ends with a catch-up pass.
      return pass(s, transcript, Object.keys(s.state.agents));
    case "SessionEnd":
      return sessionEnd(s, p, transcript);
    default:
      throw new Error(`unhandled event ${event ?? "(none)"}`);
  }
}

function sessionStart(s: Session, cwd: string): void {
  // Resume and compaction fire SessionStart again for the same session.
  if (s.state.started || s.state.start) return;
  if (!prepareStart(s, cwd)) return;
  const dirty = dirtyPaths(s.root).filter((p) => !isStorePath(p));
  if (dirty.length > MAX_START_DIRTY) {
    appendLog(s.root, "hook", `skipped start snapshot: ${dirty.length} dirty files`);
    return;
  }
  for (const path of dirty) {
    s.state.startDirty[path] = snapshot(s.root, readIfExists(join(s.root, path))).hash;
  }
}

function prepareStart(s: Session, cwd: string): boolean {
  const base = headSha(s.root);
  if (!base) {
    appendLog(s.root, "hook", "no HEAD commit; not recording");
    return false;
  }
  const branch = currentBranch(s.root);
  const ticket = branch ? matchTicket(s.root, branch) : undefined;
  s.state.start = {
    ts: s.now(),
    base_sha: base,
    cwd,
    ...(branch ? { branch } : {}),
    ...(ticket ? { ticket } : {}),
  };
  return true;
}

// session_start is written lazily so the first prompt can go in it, and so a
// session whose SessionStart we missed (hooks installed mid-session) still
// gets one.
function ensureStarted(s: Session, cwd: string, prompt?: string): boolean {
  if (s.state.started) return true;
  if (!s.state.start && !prepareStart(s, cwd)) return false;
  const start = s.state.start!;
  s.emit({
    v: 1,
    type: "session_start",
    ts: start.ts,
    agent: "claude-code",
    session_id: s.id,
    base_sha: start.base_sha,
    ...(start.branch ? { branch: start.branch } : {}),
    ...(start.ticket ? { ticket: start.ticket } : {}),
    ...(prompt ? { prompt } : {}),
    cwd: start.cwd,
  });
  s.state.started = true;
  return true;
}

function matchTicket(root: string, branch: string): string | undefined {
  let pattern = DEFAULT_TICKET_PATTERN;
  try {
    const config = JSON.parse(fs.readFileSync(configPath(root), "utf8")) as {
      capture?: { ticket_pattern?: unknown };
    };
    if (typeof config.capture?.ticket_pattern === "string") pattern = config.capture.ticket_pattern;
  } catch {
    // no config: default pattern
  }
  try {
    return new RegExp(pattern, "i").exec(branch)?.[0]?.toUpperCase();
  } catch {
    return undefined;
  }
}

function edit(s: Session, p: Payload, agentId: string | undefined): void {
  const tool = str(p.tool_name);
  const id = str(p.tool_use_id);
  if (!tool || !id || !EDIT_TOOLS.has(tool)) return;
  const input = obj(p.tool_input);
  const path = s.repoPath(input.file_path ?? input.notebook_path);
  if (!path || path === "." || isStorePath(path)) return; // outside the repo

  const ts = s.now();
  const baseline = baselineHash(s, path);
  // PostToolUse carries the pre-edit file, so PreToolUse isn't needed. Not
  // every tool sends it; then the last known state stands in.
  const original = obj(p.tool_response).originalFile;
  const before =
    typeof original === "string"
      ? snapshot(s.root, original)
      : original === null
        ? snapshot(s.root, null)
        : { hash: baseline, tooLarge: false };

  // Someone else (the user, a formatter, a script) changed the file since we
  // last saw it.
  if (before.hash !== baseline) {
    s.emit({
      v: 1,
      type: "external_change",
      ts,
      path,
      before_hash: baseline,
      after_hash: before.hash,
    });
  }

  const after = snapshot(s.root, readIfExists(join(s.root, path)));
  const link = s.state.links[id];
  delete s.state.links[id];
  s.emit({
    v: 1,
    type: "edit",
    ts,
    id,
    path,
    tool,
    before_hash: before.hash,
    after_hash: after.hash,
    ...(link
      ? {
          intent_id: link.intent_id,
          ...(link.msg_ref ? { msg_ref: link.msg_ref } : {}),
          ...(link.plan_step ? { plan_step: link.plan_step } : {}),
        }
      : {}),
    ...(before.tooLarge || after.tooLarge ? { too_large: true } : {}),
    ...agent(agentId),
  });
  s.state.lastHash[path] = after.hash;
  if (!link) s.state.unresolved[id] = agentId ?? "main";
}

// What we expect the file to contain if nobody else touched it: our last
// sighting, else its state at session start, else HEAD.
function baselineHash(s: Session, path: string): string | null {
  if (path in s.state.lastHash) return s.state.lastHash[path]!;
  if (path in s.state.startDirty) return s.state.startDirty[path]!;
  return snapshot(s.root, headContents(s.root, [path]).get(path) ?? null).hash;
}

function bashFailure(s: Session, p: Payload): void {
  const id = str(p.tool_use_id);
  if (str(p.tool_name) !== "Bash" || !id) return;
  const exit = p.is_interrupt === true ? -1 : parseExit(str(p.error) ?? "");
  const ms = typeof p.duration_ms === "number" ? Math.max(0, Math.round(p.duration_ms)) : 0;
  s.state.bashFailures[id] = { exit, duration_ms: ms };
}

function taskCreated(s: Session, p: Payload, agentId: string | undefined): void {
  const taskId = str(p.task_id);
  const subject = str(p.task_subject);
  if (!taskId || !subject) return;
  const description = str(p.task_description);
  s.emit({
    v: 1,
    type: "intent",
    ts: s.now(),
    id: `p${taskId}`,
    why: description ? `${subject}: ${description}` : subject,
    source: "plan_step",
    ...agent(agentId),
  });
}

// Walk the main transcript, then the given subagents'. The main one goes
// first so plan-step changes it records apply to the subagents' edits.
function pass(s: Session, transcript: string | undefined, agentIds: string[]): void {
  if (!transcript) return;
  walkTranscript(s, transcript);
  for (const id of agentIds) {
    const path = subagentTranscript(s, transcript, id);
    if (path) walkTranscript(s, path, id);
  }
}

// Claude Code writes subagent transcripts to
// <session>/subagents/agent-<id>.jsonl beside the main <session>.jsonl.
function subagentTranscript(s: Session, transcript: string, agentId: string): string | undefined {
  const known = s.state.agents[agentId];
  if (known) return known;
  const dir = dirname(transcript);
  const file = `agent-${agentId}.jsonl`;
  const candidates = [
    join(dir, basename(transcript, ".jsonl"), "subagents", file),
    join(dir, "subagents", file),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

function sessionEnd(s: Session, p: Payload, transcript: string | undefined): void {
  pass(s, transcript, Object.keys(s.state.agents));
  const ts = s.now();

  // Edits whose tool_use never turned up in a transcript fall back to the
  // last prompt, so every edit ends up with some intent.
  for (const [editId, agentKey] of Object.entries(s.state.unresolved)) {
    if (!s.state.lastPrompt) break;
    const agentId = agentKey === "main" ? undefined : agentKey;
    s.link(editId, s.promptIntent(s.state.lastPrompt, agentId, ts), undefined, ts);
  }
  // Links for edits that never fired a hook (rejected edits) are dead now.
  s.state.links = {};
  flushDelegations(s, ts);

  externalChanges(s, ts);
  s.emit({
    v: 1,
    type: "session_end",
    ts,
    ...(transcript ? { transcript_path: transcript } : {}),
    ...(str(p.reason) ? { reason: str(p.reason) } : {}),
  });
  // DB-15: spawn a detached `diffbrief enrich --target worktree --open` here.
}

// Files a batch's Bash calls changed (scripts, codegen, formatters, sed)
// become edits by that call, so the transcript walk can give them the same
// reason an Edit would get. Found by comparing the tree with what we last saw,
// once per batch: hooks run serially, so a PostToolUse per Bash call would
// add ~100 ms to every command (DB-04). A walk that reads the transcript
// before this batch ends (a subagent's batch, while this one waits on it)
// misses the call; its edits then fall back to the prompt at session end.
function bashEdits(s: Session, p: Payload, agentId: string | undefined): void {
  const calls = (Array.isArray(p.tool_calls) ? p.tool_calls : [])
    .map(obj)
    .filter((c) => c.tool_name === "Bash" && str(c.tool_use_id));
  if (calls.length === 0) return;
  const ts = s.now();
  for (const { path, before, after } of changedFiles(s)) {
    const call = callFor(calls, path);
    const callId = str(call.tool_use_id)!;
    const id = `${callId}:${path}`;
    s.emit({
      v: 1,
      type: "edit",
      ts,
      id,
      path,
      tool: "Bash",
      before_hash: before,
      after_hash: after.hash,
      ...(after.tooLarge ? { too_large: true } : {}),
      ...agent(agentId),
    });
    s.state.lastHash[path] = after.hash;
    s.state.unresolved[id] = agentId ?? "main";
    (s.state.bashEdits[callId] ??= []).push(id);
  }
}

// With several Bash calls in one batch, the one whose command names the file,
// if exactly one does; otherwise the last.
function callFor(calls: Record<string, unknown>[], path: string): Record<string, unknown> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const naming = calls.filter((c) => {
    const cmd = str(obj(c.tool_input).command) ?? "";
    return cmd.includes(path) || cmd.includes(name);
  });
  return naming.length === 1 ? naming[0]! : calls[calls.length - 1]!;
}

// Changes nobody reported: edits the user made after the agent's last touch,
// changes after the last batch.
function externalChanges(s: Session, ts: string): void {
  for (const { path, before, after } of changedFiles(s)) {
    s.emit({
      v: 1,
      type: "external_change",
      ts,
      path,
      before_hash: before,
      after_hash: after.hash,
    });
    s.state.lastHash[path] = after.hash;
  }
}

// Files that differ from what we last saw (else their state at session start,
// else HEAD), sorted by path.
function changedFiles(s: Session): { path: string; before: string | null; after: Snapshot }[] {
  const { lastHash, startDirty } = s.state;
  const dirty = dirtyPaths(s.root);
  if (dirty.length > MAX_START_DIRTY) {
    appendLog(s.root, "hook", `skipped change scan: ${dirty.length} dirty files`);
    return [];
  }
  const paths = new Set([...dirty, ...Object.keys(lastHash)]);
  const unseen = [...paths].filter((p) => !(p in lastHash) && !(p in startDirty));
  const head = headContents(s.root, unseen);

  const changed = [];
  for (const path of [...paths].sort()) {
    if (isStorePath(path)) continue;
    const before =
      path in lastHash
        ? lastHash[path]!
        : path in startDirty
          ? startDirty[path]!
          : snapshot(s.root, head.get(path) ?? null).hash;
    const after = snapshot(s.root, readIfExists(join(s.root, path)));
    if (after.hash !== before) changed.push({ path, before, after });
  }
  return changed;
}

function isStorePath(path: string): boolean {
  return path === STORE_DIR || path.startsWith(`${STORE_DIR}/`);
}

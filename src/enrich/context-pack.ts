import { structuredPatch, type StructuredPatchHunk } from "diff";
import type { EventOf } from "../schema/events.js";
import type { MergedEvent } from "../target/index.js";
import { planSteps, type Episode } from "./episodes.js";

// What the model sees for one episode (DB-10): the request, the plan, the
// statements before the edits, and each edit's own diff. File contents are
// left out on purpose, to keep the pack small.

export type PlanStep = { id: string; why: string };
export type Msg = { id: string; text: string };

export type PackEdit = {
  id: string;
  path: string;
  planStep?: string;
  // None of its lines survive into the final diff (DB-08).
  deadEnd?: true;
  unifiedDiff: string;
};

export type ContextPack = {
  ticket?: string;
  prompts: string[];
  plan: PlanStep[];
  // Last 3 agent messages before the first edit, verbatim, with ids. A
  // regrouped episode also keeps its own statements between its edits.
  priorMessages: Msg[];
  readPaths: string[];
  edits: PackEdit[];
  commandsAfter: { cmd: string; exit: number; kind?: string }[];
  // The token budget cut diffs or messages beyond the per-edit cap.
  truncated?: true;
};

export type PackOptions = {
  // Snapshot by hash, null if it isn't stored.
  blob(hash: string): Buffer | null;
  // Edit ids of DB-08 dead ends.
  deadEnds?: Iterable<string>;
  maxTokens?: number;
  maxDiffLines?: number;
};

const MAX_TOKENS = 6000;
const MAX_DIFF_LINES = 200;
const PRIOR_MESSAGES = 3;
const DIFF_TIMEOUT_MS = 1000;

type Edit = EventOf<"edit"> & { session_id: string };
type Patch = { header: string; hunks: StructuredPatchHunk[] } | { note: string };

// One pack per episode, in the same order.
export function buildContextPacks(
  events: MergedEvent[],
  episodes: Episode[],
  opts: PackOptions,
): ContextPack[] {
  const steps = planSteps(events);
  const deadEnds = new Set(opts.deadEnds ?? []);
  const edits = new Map<string, Edit>();
  const commands = new Map<string, EventOf<"command">>();
  for (const e of events) {
    if (e.type === "edit") edits.set(e.id, e);
    else if (e.type === "command") commands.set(e.id, e);
  }

  return episodes.map((ep) => {
    const end = Date.parse(ep.end_ts);
    const session = events.filter((e) => e.session_id === ep.session_id);
    const epEdits = ep.edit_ids.map((id) => edits.get(id)!);
    const firstEdit = Math.min(...epEdits.map((e) => Date.parse(e.ts)));

    const start = session.find((e) => e.type === "session_start");
    const prompts = session.flatMap((e) => {
      if (Date.parse(e.ts) > end) return [];
      if (e.type === "session_start") return e.prompt ? [e.prompt] : [];
      return e.type === "prompt" ? [e.text] : [];
    });
    const plan = session.flatMap((e) =>
      e.type === "intent" && e.source === "plan_step" && Date.parse(e.ts) <= end
        ? [{ id: e.id, why: e.why }]
        : [],
    );

    const patches = epEdits.map((e) => patchOf(e, opts.blob));
    const pack: ContextPack = {
      ...(start?.ticket ? { ticket: start.ticket } : {}),
      prompts,
      plan,
      priorMessages: priorMessages(session, ep, firstEdit),
      readPaths: ep.read_paths,
      edits: [],
      commandsAfter: ep.command_ids
        .map((id) => commands.get(id)!)
        .filter((c) => Date.parse(c.ts) >= firstEdit)
        .map((c) => ({ cmd: c.cmd, exit: c.exit, ...(c.kind ? { kind: c.kind } : {}) })),
    };
    const render = (limit: number) => {
      pack.edits = epEdits.map((e, i) => ({
        id: e.id,
        path: e.path,
        ...(steps.has(e.id) ? { planStep: steps.get(e.id)! } : {}),
        ...(deadEnds.has(e.id) ? { deadEnd: true as const } : {}),
        unifiedDiff: renderPatch(patches[i]!, limit),
      }));
    };
    fitBudget(pack, patches, render, opts);
    return pack;
  });
}

// Messages a subagent's episode may cite include the main agent's, which
// delegated the work.
function priorMessages(session: MergedEvent[], ep: Episode, firstEdit: number): Msg[] {
  const own = new Set(ep.message_ids);
  const msgs = session
    .filter(
      (e): e is EventOf<"agent_message"> & { session_id: string } => e.type === "agent_message",
    )
    .filter((m) => m.agent_id === ep.agent_id || (ep.agent_id && !m.agent_id))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const before = msgs.filter((m) => Date.parse(m.ts) < firstEdit).slice(-PRIOR_MESSAGES);
  const between = msgs.filter((m) => own.has(m.id) && Date.parse(m.ts) >= firstEdit);
  return [...before, ...between].map((m) => ({ id: m.id, text: m.text }));
}

// Estimated as chars/4. Over budget, diffs shrink first (hunk headers stay),
// then the oldest prior messages go; the newest always stays.
function fitBudget(
  pack: ContextPack,
  patches: Patch[],
  render: (limit: number) => void,
  opts: PackOptions,
): void {
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const over = () => Math.ceil(JSON.stringify(pack).length / 4) > maxTokens;
  let limit = opts.maxDiffLines ?? MAX_DIFF_LINES;
  render(limit);
  if (!over()) return;
  pack.truncated = true;

  const longest = Math.max(0, ...patches.map(bodyLines));
  limit = Math.min(limit, longest);
  while (over() && limit > 0) {
    limit = Math.floor(limit / 2);
    render(limit);
  }
  while (over() && pack.priorMessages.length > 1) pack.priorMessages.shift();
}

function patchOf(e: Edit, blob: PackOptions["blob"]): Patch {
  if (e.too_large) return { note: "(too large to record)" };
  const before = e.before_hash === null ? Buffer.alloc(0) : blob(e.before_hash);
  const after = e.after_hash === null ? Buffer.alloc(0) : blob(e.after_hash);
  if (!before || !after) return { note: "(contents not recorded)" };
  if (isBinary(before) || isBinary(after)) return { note: "(binary file)" };
  const oldName = e.before_hash === null ? "/dev/null" : `a/${e.old_path ?? e.path}`;
  const newName = e.after_hash === null ? "/dev/null" : `b/${e.path}`;
  const patch = structuredPatch(
    oldName,
    newName,
    before.toString("utf8"),
    after.toString("utf8"),
    undefined,
    undefined,
    { context: 3, timeout: DIFF_TIMEOUT_MS },
  );
  if (!patch) return { note: "(diff too costly to compute)" };
  if (patch.hunks.length === 0) return { note: "(no change)" };
  return { header: `--- ${oldName}\n+++ ${newName}`, hunks: patch.hunks };
}

function bodyLines(p: Patch): number {
  return "hunks" in p ? p.hunks.reduce((n, h) => n + h.lines.length, 0) : 0;
}

// Every hunk header is kept; body lines are spent in order until `limit`
// runs out, and each cut is marked.
function renderPatch(p: Patch, limit: number): string {
  if (!("hunks" in p)) return p.note;
  const out = [p.header];
  let left = limit;
  for (const h of p.hunks) {
    out.push(`@@ -${start(h.oldStart, h.oldLines)} +${start(h.newStart, h.newLines)} @@`);
    const keep = h.lines.slice(0, Math.max(0, left));
    out.push(...keep);
    left -= keep.length;
    if (keep.length < h.lines.length) out.push(`… ${h.lines.length - keep.length} lines omitted`);
  }
  return out.join("\n");
}

// An empty side starts at 0, as git prints it.
function start(line: number, count: number): string {
  return `${count === 0 ? line - 1 : line},${count}`;
}

function isBinary(b: Buffer): boolean {
  return b.subarray(0, 8000).includes(0);
}

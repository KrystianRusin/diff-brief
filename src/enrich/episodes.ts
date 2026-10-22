import { createHash } from "node:crypto";
import type { EventType } from "../schema/events.js";
import type { MergedEvent } from "../target/index.js";

// Splits the merged timeline into episodes (DB-10): reads, a statement,
// edits, then a test or command. Model enrich reads one episode at a time
// instead of the raw, noisy message stream. Deterministic, no model.

export type Episode = {
  id: string;
  session_id: string;
  agent_id?: string; // a subagent's episode; absent for the main agent
  start_ts: string;
  end_ts: string;
  message_ids: string[];
  edit_ids: string[];
  command_ids: string[];
  read_paths: string[];
  plan_step_ids: string[];
};

export type SplitOptions = {
  // An episode editing more distinct files than this is regrouped by plan
  // step, when its edits have one.
  maxFiles?: number;
};

const MAX_FILES = 6;

type Of<T extends EventType> = Extract<MergedEvent, { type: T }>;
export type Member = Of<"agent_message"> | Of<"edit"> | Of<"command"> | Of<"read">;

const isMember = (e: MergedEvent): e is Member =>
  e.type === "agent_message" || e.type === "edit" || e.type === "command" || e.type === "read";

export function splitEpisodes(events: MergedEvent[], opts: SplitOptions = {}): Episode[] {
  const steps = planSteps(events);
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const episodes: Episode[] = [];
  for (const stream of streams(events)) {
    // Episodes without edits (a closing summary, a command on its own) have
    // nothing to explain.
    const split = splitStream(stream).filter((ep) => ep.some((e) => e.type === "edit"));
    for (const ep of regroup(split, steps, maxFiles)) episodes.push(toEpisode(ep, steps));
  }
  return episodes.sort((a, b) => Date.parse(a.start_ts) - Date.parse(b.start_ts));
}

// The plan step each edit was made under: the adapter's plan_step, or the
// edit's intent when that is itself a plan step. edit_link overrides the
// edit's own fields, a later link winning, as in mapping.
export function planSteps(events: MergedEvent[]): Map<string, string> {
  const planIntents = new Set(
    events.flatMap((e) => (e.type === "intent" && e.source === "plan_step" ? [e.id] : [])),
  );
  const links = new Map<string, { intent?: string; step?: string }>();
  for (const e of events) {
    if (e.type === "edit") {
      if (!links.has(e.id)) links.set(e.id, { intent: e.intent_id, step: e.plan_step });
    } else if (e.type === "edit_link") {
      links.set(e.edit_id, { intent: e.intent_id, step: e.plan_step });
    }
  }
  const steps = new Map<string, string>();
  for (const [editId, { intent, step }] of links) {
    const s = step ?? (intent && planIntents.has(intent) ? intent : undefined);
    if (s) steps.set(editId, s);
  }
  return steps;
}

// One stream per session and agent, so a subagent's messages don't cut the
// main agent's episodes, and a session boundary always closes one. Sorted by
// time: the adapter writes edits from hooks as they happen but messages,
// reads and commands from a transcript walk that lags behind.
function streams(events: MergedEvent[]): Member[][] {
  const byKey = new Map<string, Member[]>();
  for (const e of events) {
    if (!isMember(e)) continue;
    const key = `${e.session_id}\0${e.agent_id ?? ""}`;
    let s = byKey.get(key);
    if (!s) byKey.set(key, (s = []));
    s.push(e);
  }
  // Array.sort is stable, so events with equal ts keep their log order.
  return [...byKey.values()].map((s) => s.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)));
}

// Close the current episode when a statement follows an edit or command, or
// after a test or build that isn't followed by another command.
function splitStream(stream: Member[]): Member[][] {
  const out: Member[][] = [];
  let cur: Member[] = [];
  let acted = false;
  const close = () => {
    if (cur.length) out.push(cur);
    cur = [];
    acted = false;
  };
  stream.forEach((e, i) => {
    if (e.type === "agent_message" && acted) close();
    cur.push(e);
    if (e.type === "edit" || e.type === "command") acted = true;
    if (
      e.type === "command" &&
      (e.kind === "test" || e.kind === "build") &&
      stream[i + 1]?.type !== "command"
    ) {
      close();
    }
  });
  close();
  return out;
}

// Time-based episodes go wrong when the agent works on several plan steps
// at once: one episode edits many files with no statement in between (a
// statement after an edit would have closed it), or episodes alternate
// between the same files (A, B, A). Those regions are regrouped by plan
// step. Edits with no plan step stay with their original episode.
function regroup(episodes: Member[][], steps: Map<string, string>, maxFiles: number): Member[][] {
  const files = episodes.map(
    (ep) => new Set(ep.flatMap((e) => (e.type === "edit" ? [e.path] : []))),
  );
  const tied = (ep: Member[]) => ep.some((e) => e.type === "edit" && steps.has(e.id));

  const out: Member[][] = [];
  let i = 0;
  while (i < episodes.length) {
    // It takes three episodes to alternate; the run then extends while the
    // pattern holds.
    let end = i + 1;
    if (i + 2 < episodes.length && alternates(files, i + 2)) {
      end = i + 3;
      while (end < episodes.length && alternates(files, end)) end++;
    }
    const region = episodes.slice(i, end);
    if (region.length === 1 && files[i]!.size <= maxFiles) {
      out.push(episodes[i]!);
      i++;
      continue;
    }
    if (region.some(tied)) out.push(...byPlanStep(region, steps));
    else out.push(...region);
    i += region.length;
  }
  return out;
}

// Episode k edits a file episode k-2 edited, and none episode k-1 did.
function alternates(files: Set<string>[], k: number): boolean {
  if (k < 2) return false;
  const [a, b, c] = [files[k - 2]!, files[k - 1]!, files[k]!];
  return [...c].some((f) => a.has(f)) && ![...c].some((f) => b.has(f));
}

function byPlanStep(region: Member[][], steps: Map<string, string>): Member[][] {
  const groups = new Map<string, Member[]>();
  region.forEach((ep, n) => {
    const keys = ep.map((e) => (e.type === "edit" ? (steps.get(e.id) ?? `#${n}`) : undefined));
    ep.forEach((e, j) => {
      // Statements and reads lead into the next edit; commands check the
      // edit before them. Either way, within the member's own episode.
      const key =
        keys[j] ??
        (e.type === "command"
          ? (lastBefore(keys, j) ?? firstAfter(keys, j))
          : (firstAfter(keys, j) ?? lastBefore(keys, j)))!;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(e);
    });
  });
  return [...groups.values()]
    .map((g) => g.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)))
    .sort((a, b) => Date.parse(a[0]!.ts) - Date.parse(b[0]!.ts));
}

function firstAfter<T>(xs: (T | undefined)[], j: number): T | undefined {
  for (let k = j + 1; k < xs.length; k++) if (xs[k] !== undefined) return xs[k];
  return undefined;
}

function lastBefore<T>(xs: (T | undefined)[], j: number): T | undefined {
  for (let k = j - 1; k >= 0; k--) if (xs[k] !== undefined) return xs[k];
  return undefined;
}

function toEpisode(members: Member[], steps: Map<string, string>): Episode {
  const first = members[0]!;
  const ids = (t: "agent_message" | "edit" | "command") =>
    members.flatMap((e) => (e.type === t ? [e.id] : []));
  const editIds = ids("edit");
  return {
    // Each edit is in exactly one episode, so its edits identify it, and the
    // id holds across re-runs while the episode's edits stay the same.
    id: "ep-" + createHash("sha256").update(editIds.join("\n")).digest("hex").slice(0, 12),
    session_id: first.session_id,
    ...(first.agent_id ? { agent_id: first.agent_id } : {}),
    start_ts: first.ts,
    end_ts: members[members.length - 1]!.ts,
    message_ids: ids("agent_message"),
    edit_ids: editIds,
    command_ids: ids("command"),
    read_paths: unique(members.flatMap((e) => (e.type === "read" ? [e.path] : []))),
    plan_step_ids: unique(editIds.flatMap((id) => steps.get(id) ?? [])),
  };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

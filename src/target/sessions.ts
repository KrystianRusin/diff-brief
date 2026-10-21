import type { Hunk } from "../diff/index.js";
import type { Event } from "../schema/events.js";
import { listSessions, readEvents } from "../store/read.js";
import type { ResolvedTarget } from "./index.js";
import { isAncestor, resolveCommit } from "./refs.js";

// Which sessions feed a diff target, and their logs merged into one timeline
// for mapping (DB-08) and enrich (DB-13).

export type SessionEvents = { id: string; events: Event[] };

export type MergedEvent = Event & { session_id: string };

// Per-session material for the briefing prompt, in session order.
export type SessionContext = {
  sessionId: string;
  ticket?: string;
  branch?: string;
  prompts: string[];
  plan: { id: string; why: string }[];
};

// How long before the base commit a session may have stopped and still have
// work that isn't in it. Over-including is safe here: mapping skips
// snapshots the base already contains.
const BASE_SLACK_MS = 15 * 60 * 1000;
// Commit times are whole seconds; anything later than this can't be in the
// head commit.
const HEAD_SLACK_MS = 1000;

// Selection is tight on purpose. Mapping follows each file through one
// timeline, so a foreign session's snapshots of the same file (another
// branch, work already committed before the base) would read as external
// changes and take lines away from the right intents.
export function selectSessions(
  root: string,
  resolved: ResolvedTarget,
  hunks: Hunk[],
  sessions: SessionEvents[],
): SessionEvents[] {
  const paths = new Set(hunks.flatMap((h) => (h.oldPath ? [h.path, h.oldPath] : [h.path])));
  const { target } = resolved;
  const headSha = target.head === "WORKTREE" ? undefined : target.head;

  return sessions.filter(({ events }) => {
    const touched = events.filter(
      (e) => (e.type === "edit" || e.type === "external_change") && paths.has(e.path),
    );
    if (touched.length === 0) return false;
    const start = events.find((e) => e.type === "session_start");
    const times = events.map((e) => Date.parse(e.ts));
    const last = Math.max(...times);

    // Still working after the base was committed; otherwise its work is
    // already in the base.
    if (resolved.baseTime !== undefined && last < resolved.baseTime - BASE_SLACK_MS) return false;

    if (!headSha) {
      // Worktree: the branch it ran on, when both sides know one.
      return !(resolved.branch && start?.branch && start.branch !== resolved.branch);
    }
    // Commit or range: edits made before the head was committed, on a base
    // the head descends from.
    const firstEdit = Math.min(...touched.map((e) => Date.parse(e.ts)));
    if (resolved.headTime !== undefined && firstEdit > resolved.headTime + HEAD_SLACK_MS)
      return false;
    const base = start && resolveCommit(root, start.base_sha);
    return !base || isAncestor(root, base, headSha);
  });
}

// One timeline from several sessions. Ids are namespaced by session
// ("<session8>:<id>") so they can't collide, and each event keeps its
// session_id. Sessions are interleaved by time but each keeps its own order:
// an edit_link can carry an earlier ts than the edit it links, and must
// still come after it.
export function mergeSessions(sessions: SessionEvents[]): {
  events: MergedEvent[];
  context: SessionContext[];
} {
  const queues = sessions.map((s) => ({ s, i: 0, clock: -Infinity }));
  const events: MergedEvent[] = [];
  for (;;) {
    let pick: (typeof queues)[number] | undefined;
    let pickAt = Infinity;
    for (const q of queues) {
      const e = q.s.events[q.i];
      if (!e) continue;
      // A session's clock never runs backwards, so out-of-order ts inside
      // one session can't pull its events ahead of another's.
      const at = Math.max(q.clock, Date.parse(e.ts));
      if (at < pickAt) [pick, pickAt] = [q, at];
    }
    if (!pick) break;
    pick.clock = pickAt;
    events.push(namespace(pick.s.events[pick.i++]!, pick.s.id));
  }

  const context = sessions.map(({ id, events: evs }) => {
    const ns = prefix(id);
    const start = evs.find((e) => e.type === "session_start");
    const prompts = [
      ...(start?.prompt ? [start.prompt] : []),
      ...evs.flatMap((e) => (e.type === "prompt" ? [e.text] : [])),
    ];
    const plan = evs.flatMap((e) =>
      e.type === "intent" && e.source === "plan_step" ? [{ id: ns(e.id), why: e.why }] : [],
    );
    return {
      sessionId: id,
      ...(start?.ticket ? { ticket: start.ticket } : {}),
      ...(start?.branch ? { branch: start.branch } : {}),
      prompts,
      plan,
    };
  });
  return { events, context };
}

// Everything recorded under .diffbrief/ that feeds this target, merged.
export function gatherSessions(root: string, resolved: ResolvedTarget, hunks: Hunk[]) {
  const all = listSessions(root)
    .reverse() // oldest first
    .map(({ id }) => ({ id, events: readEvents(root, id).events }));
  const selected = selectSessions(root, resolved, hunks, all).map((s) => trim(s, resolved));
  return { sessionIds: selected.map((s) => s.id), ...mergeSessions(selected) };
}

// For a commit or range, what happened after the head was committed isn't
// part of it; left in, those edits would read as dead ends.
function trim(s: SessionEvents, resolved: ResolvedTarget): SessionEvents {
  if (resolved.headTime === undefined) return s;
  const cutoff = resolved.headTime + HEAD_SLACK_MS;
  return { id: s.id, events: s.events.filter((e) => Date.parse(e.ts) <= cutoff) };
}

function prefix(sessionId: string) {
  const p = sessionId.slice(0, 8);
  return (id: string) => `${p}:${id}`;
}

function namespace(e: Event, sessionId: string): MergedEvent {
  const ns = prefix(sessionId);
  switch (e.type) {
    case "intent":
      return {
        ...e,
        session_id: sessionId,
        id: ns(e.id),
        ...(e.msg_ref ? { msg_ref: ns(e.msg_ref) } : {}),
        ...(e.serves ? { serves: ns(e.serves) } : {}),
      };
    case "agent_message":
    case "command":
      return { ...e, session_id: sessionId, id: ns(e.id) };
    case "edit":
      return {
        ...e,
        session_id: sessionId,
        id: ns(e.id),
        ...(e.intent_id ? { intent_id: ns(e.intent_id) } : {}),
        ...(e.msg_ref ? { msg_ref: ns(e.msg_ref) } : {}),
      };
    case "edit_link":
      return {
        ...e,
        session_id: sessionId,
        edit_id: ns(e.edit_id),
        intent_id: ns(e.intent_id),
        ...(e.msg_ref ? { msg_ref: ns(e.msg_ref) } : {}),
      };
    default:
      return { ...e, session_id: sessionId };
  }
}

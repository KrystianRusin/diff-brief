import { isAbsolute, relative, sep } from "node:path";
import type { Event } from "../../schema/events.js";
import { hashContent, putBlob } from "../../store/blobs.js";
import { fs } from "../../store/builtins.js";
import { appendEvent } from "../../store/sessions.js";
import type { CaptureState } from "./state.js";

// Blobs over this are hashed but not stored (DB-05 performance budget).
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

// One hook invocation's view of a session: where to write, the loaded state,
// and the id and intent bookkeeping shared by the handlers and the
// transcript walk.
export class Session {
  constructor(
    readonly root: string,
    readonly id: string,
    readonly state: CaptureState,
    readonly now: () => string,
  ) {}

  emit(event: Event): void {
    appendEvent(this.root, this.id, event);
  }

  nextId(kind: "m" | "i"): string {
    return `${kind}${++this.state.counters[kind]}`;
  }

  // Attach an intent to an edit. If the edit hook hasn't fired yet (the
  // transcript can run ahead of it), park the link for the edit to pick up.
  link(
    editId: string,
    intentId: string,
    msgRef: string | undefined,
    ts: string,
    planStep?: string,
  ): void {
    const extra = {
      ...(msgRef ? { msg_ref: msgRef } : {}),
      ...(planStep ? { plan_step: planStep } : {}),
    };
    if (editId in this.state.unresolved) {
      delete this.state.unresolved[editId];
      this.emit({
        v: 1,
        type: "edit_link",
        ts,
        edit_id: editId,
        intent_id: intentId,
        ...extra,
      });
    } else {
      this.state.links[editId] = { intent_id: intentId, ...extra };
    }
  }

  // One intent per distinct prompt text, created the first time an edit
  // falls back to it.
  promptIntent(text: string, agentId: string | undefined, ts: string): string {
    const known = this.state.promptIntents[text];
    if (known) return known;
    const id = this.nextId("i");
    this.state.promptIntents[text] = id;
    this.emit({ v: 1, type: "intent", ts, id, why: text, source: "prompt", ...agent(agentId) });
    return id;
  }

  // Repo-relative path with forward slashes, or null outside the repo.
  repoPath(path: unknown): string | null {
    if (typeof path !== "string" || path === "") return null;
    const rel = relative(this.root, isAbsolute(path) ? path : `${this.root}${sep}${path}`);
    if (rel === "") return ".";
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
  }
}

export function agent(agentId: string | undefined): { agent_id?: string } {
  return agentId ? { agent_id: agentId } : {};
}

export type Snapshot = { hash: string | null; tooLarge: boolean };

// Hash content and store it as a blob, unless it's too large to keep.
export function snapshot(root: string, content: Buffer | string | null): Snapshot {
  if (content === null) return { hash: null, tooLarge: false };
  const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
  if (size > MAX_BLOB_BYTES) return { hash: hashContent(content), tooLarge: true };
  return { hash: putBlob(root, content), tooLarge: false };
}

export function readIfExists(path: string): Buffer | null {
  try {
    return fs.readFileSync(path);
  } catch {
    return null;
  }
}

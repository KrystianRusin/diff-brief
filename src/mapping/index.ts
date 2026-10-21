import { diffArrays } from "diff";
import type { TargetContents } from "../diff/contents.js";
import type { Hunk } from "../diff/index.js";
import type { Event } from "../schema/events.js";
import { hashContent } from "../store/blobs.js";

// Ties intents recorded at edit time to hunks in the final diff (DB-08).
//
// Every edit and external change carries before/after snapshots, so for each
// file we replay the chain base -> step -> ... -> final content and keep one
// origin per line, like `git blame` over the snapshots. A final hunk's intent
// is then read off the origins of its lines, however far line numbers drifted
// in between.

export type MappingMode = "line" | "file";

export type MapInput = {
  hunks: Hunk[];
  // One session's events, or DB-09's merged timeline, in order.
  events: Event[];
  contents: TargetContents;
  // Snapshot by hash, null if it isn't stored (too_large, or lost).
  blob(hash: string): Buffer | null;
  mode?: MappingMode;
};

export type HunkMapping = {
  intentId?: string;
  history: string[]; // other intents that wrote or were replaced in this hunk, oldest first
  serves?: "unexplained";
  externalTouched: boolean;
  editIds: string[];
  mode: MappingMode;
};

// An edit none of whose lines survive into the final content.
export type DeadEnd = { editId: string; intentId?: string; removedByEditId?: string };

export type MapResult = { byHunk: Record<string, HunkMapping>; deadEnds: DeadEnd[] };

type EditOrigin = { kind: "edit"; step: number; editId: string; intentId?: string };
type Origin = { kind: "base" } | EditOrigin | { kind: "external"; step: number };

type Line = {
  text: string;
  origin: Origin;
  base?: string; // "<path>:<0-based index>" for lines from the base content
  history: EditOrigin[]; // edits whose lines this one replaced
  touched?: true; // an external step changed only its whitespace
};

type FileState = { hash: string | null; lines: Line[] };

// A file whose chain can't be followed (missing snapshot, diff too costly).
class Lost extends Error {}

const DIFF_TIMEOUT_MS = 1000;

export function mapHunks(input: MapInput): MapResult {
  const intents = resolveIntents(input.events);
  const t = new Tracker(input, intents);
  t.run();

  const byHunk: Record<string, HunkMapping> = {};
  for (const h of input.hunks) {
    const fileMode = input.mode === "file" || h.lines.length === 0 || t.isLost(h.path, h.oldPath);
    byHunk[h.id] = fileMode ? t.fileMapping(h) : t.lineMapping(h);
  }
  return { byHunk, deadEnds: t.deadEnds() };
}

// Final intent per edit: its own intent_id, overridden by edit_link events,
// a later link winning.
function resolveIntents(events: Event[]): Map<string, string | undefined> {
  const intents = new Map<string, string | undefined>();
  for (const e of events) {
    if (e.type === "edit") intents.set(e.id, e.intent_id);
    else if (e.type === "edit_link") intents.set(e.edit_id, e.intent_id);
  }
  return intents;
}

class Tracker {
  private files = new Map<string, FileState>();
  private lost = new Set<string>();
  // Line provenance by content hash, so a file that reappears with known
  // content (mv, cp, a revert) keeps its origins instead of turning external.
  private known = new Map<string, Line[]>();
  // Base line ("<path>:<idx>") -> the step that removed it.
  private removedBy = new Map<string, Origin>();
  private inserted = new Map<string, EditOrigin>();
  private removals = new Map<string, Map<string, number>>(); // edit -> remover edit -> count
  private renamedFrom = new Map<string, string>();

  constructor(
    private input: MapInput,
    private intents: Map<string, string | undefined>,
  ) {
    for (const h of input.hunks) if (h.oldPath) this.renamedFrom.set(h.path, h.oldPath);
  }

  run(): void {
    this.input.events.forEach((e, step) => {
      if (e.type === "edit") {
        this.guard(e.path, () => {
          const origin: EditOrigin = {
            kind: "edit",
            step,
            editId: e.id,
            intentId: this.intents.get(e.id),
          };
          // A before that doesn't match what we tracked means a change the
          // hooks missed; record the difference as external first.
          this.moveTo(e.path, e.before_hash, { kind: "external", step }, false);
          this.moveTo(e.path, e.after_hash, origin, true);
        });
      } else if (e.type === "external_change") {
        this.guard(e.path, () =>
          this.moveTo(e.path, e.after_hash, { kind: "external", step }, false),
        );
      }
    });

    // Anything between the last snapshot and the final content is external:
    // a formatter after the last edit, a manual edit after the session.
    const paths = new Set([...this.files.keys(), ...this.input.hunks.map((h) => h.path)]);
    const finalStep = this.input.events.length;
    for (const path of paths) {
      this.guard(path, () => {
        const content = this.input.contents.final(path);
        this.apply(
          path,
          content,
          hashOrNull(content),
          { kind: "external", step: finalStep },
          false,
        );
      });
    }
  }

  isLost(path: string, oldPath?: string): boolean {
    return this.lost.has(path) || (oldPath !== undefined && this.lost.has(oldPath));
  }

  private guard(path: string, fn: () => void): void {
    if (this.lost.has(path)) return;
    try {
      fn();
    } catch (err) {
      if (!(err instanceof Lost)) throw err;
      this.lost.add(path);
    }
  }

  private state(path: string): FileState {
    let s = this.files.get(path);
    if (!s) {
      // A renamed file's history starts from the old path's base content.
      const basePath =
        this.input.contents.base(path) === null ? (this.renamedFrom.get(path) ?? path) : path;
      const content = this.input.contents.base(basePath);
      s = {
        hash: hashOrNull(content),
        lines: splitLines(content).map((text, i) => ({
          text,
          origin: { kind: "base" },
          base: `${basePath}:${i}`,
          history: [],
        })),
      };
      this.files.set(path, s);
      if (s.hash) this.known.set(s.hash, s.lines);
    }
    return s;
  }

  // Move a file to the snapshot `hash`, attributing the difference to origin.
  private moveTo(path: string, hash: string | null, origin: Origin, exact: boolean): void {
    if (this.state(path).hash === hash) return;
    const content = hash === null ? null : this.input.blob(hash);
    if (hash !== null && content === null) throw new Lost();
    this.apply(path, content, hash, origin, exact);
  }

  private apply(
    path: string,
    content: Buffer | null,
    hash: string | null,
    origin: Origin,
    exact: boolean,
  ): void {
    const cur = this.state(path);
    if (cur.hash === hash) return;

    // Content we've already seen elsewhere, reached by something other than
    // an agent edit, keeps the provenance it had.
    const seen = !exact && hash !== null ? this.known.get(hash) : undefined;
    const lines = seen ?? this.diffLines(cur.lines, splitLines(content), origin, exact);
    this.files.set(path, { hash, lines });
    if (hash !== null) this.known.set(hash, lines);
  }

  // Agent edits compare lines exactly, so an edit that only re-indents still
  // owns those lines. External steps compare whitespace-normalized lines, so a
  // formatter reflowing the agent's code doesn't take the lines over.
  private diffLines(old: Line[], next: string[], origin: Origin, exact: boolean): Line[] {
    const key = exact ? (s: string) => s : normalize;
    const changes = diffArrays(
      old.map((l) => key(l.text)),
      next.map(key),
      { timeout: DIFF_TIMEOUT_MS },
    );
    if (!changes) throw new Lost();

    const out: Line[] = [];
    let o = 0;
    let n = 0;
    let replaced: Line[] = [];
    for (const c of changes) {
      const count = c.count ?? c.value.length;
      if (c.removed) {
        replaced = old.slice(o, o + count);
        for (const l of replaced) this.recordRemoval(l, origin);
        o += count;
      } else if (c.added) {
        for (let i = 0; i < count; i++) {
          // Pair added lines with the lines they replaced, positionally.
          const prev = replaced[i];
          const history = prev
            ? [...prev.history, ...(prev.origin.kind === "edit" ? [prev.origin] : [])]
            : [];
          out.push({ text: next[n + i]!, origin, history });
        }
        if (origin.kind === "edit") this.inserted.set(origin.editId, origin);
        n += count;
        replaced = [];
      } else {
        for (let i = 0; i < count; i++) {
          const prev = old[o + i]!;
          const text = next[n + i]!;
          out.push(text === prev.text ? prev : { ...prev, text, touched: true });
        }
        o += count;
        n += count;
        replaced = [];
      }
    }
    return out;
  }

  private recordRemoval(line: Line, by: Origin): void {
    // The first edit to remove a base line owns its removal; an external step
    // (say, the old path of a mv disappearing at session end) never overrides it.
    if (line.base && this.removedBy.get(line.base)?.kind !== "edit")
      this.removedBy.set(line.base, by);
    if (line.origin.kind === "edit" && by.kind === "edit") {
      const counts = this.removals.get(line.origin.editId) ?? new Map<string, number>();
      counts.set(by.editId, (counts.get(by.editId) ?? 0) + 1);
      this.removals.set(line.origin.editId, counts);
    }
  }

  lineMapping(h: Hunk): HunkMapping {
    const final = this.files.get(h.path)?.lines ?? [];
    const basePath = h.oldPath ?? h.path;
    const plus = h.lines.flatMap((l) => (l.kind === "+" && l.newNo ? [final[l.newNo - 1]] : []));
    const removers = h.lines.flatMap((l) =>
      l.kind === "-" && l.oldNo ? [this.removedBy.get(`${basePath}:${l.oldNo - 1}`)] : [],
    );

    const writers = plus.map((l) => l?.origin);
    const edits = new Map<string, EditOrigin>();
    const add = (o: Origin | undefined) => {
      if (o?.kind === "edit") edits.set(o.editId, o);
    };
    writers.forEach(add);
    removers.forEach(add);
    plus.forEach((l) => l?.history.forEach(add));

    // Primary: the edit that wrote the most + lines, ties to the most recent.
    // A deletion-only hunk goes to the edit that removed its lines.
    const votes = plus.length > 0 ? writers : removers;
    const tally = new Map<string, { origin: EditOrigin; n: number }>();
    for (const o of votes) {
      if (o?.kind !== "edit") continue;
      const t = tally.get(o.editId) ?? { origin: o, n: 0 };
      t.n++;
      tally.set(o.editId, t);
    }
    let primary: EditOrigin | undefined;
    let best = 0;
    for (const { origin, n } of tally.values()) {
      if (n > best || (n === best && primary && origin.step > primary.step)) {
        primary = origin;
        best = n;
      }
    }

    const externalTouched =
      writers.some((o) => o?.kind === "external") ||
      plus.some((l) => l?.touched) ||
      removers.some((o) => o?.kind === "external");
    return this.result([...edits.values()], primary, externalTouched, "line");
  }

  // Fallback: every edit to the file, primary = the last one.
  fileMapping(h: Hunk): HunkMapping {
    const paths = new Set([h.path, ...(h.oldPath ? [h.oldPath] : [])]);
    const edits: EditOrigin[] = [];
    let externalTouched = false;
    let lastAfter: string | null | undefined;
    this.input.events.forEach((e, step) => {
      if (e.type === "edit" && paths.has(e.path)) {
        edits.push({ kind: "edit", step, editId: e.id, intentId: this.intents.get(e.id) });
        lastAfter = e.after_hash;
      } else if (e.type === "external_change" && paths.has(e.path)) {
        externalTouched = true;
      }
    });
    // Changed again after the last edit.
    if (lastAfter !== undefined && lastAfter !== hashOrNull(this.input.contents.final(h.path))) {
      externalTouched = true;
    }
    return this.result(edits, edits.at(-1), externalTouched, "file");
  }

  private result(
    edits: EditOrigin[],
    primary: EditOrigin | undefined,
    externalTouched: boolean,
    mode: MappingMode,
  ): HunkMapping {
    edits.sort((a, b) => a.step - b.step);
    const history: string[] = [];
    for (const e of edits) {
      if (e.intentId && e.intentId !== primary?.intentId && !history.includes(e.intentId)) {
        history.push(e.intentId);
      }
    }
    return {
      ...(primary?.intentId ? { intentId: primary.intentId } : {}),
      history,
      ...(primary ? {} : { serves: "unexplained" as const }),
      externalTouched,
      editIds: edits.map((e) => e.editId),
      mode,
    };
  }

  deadEnds(): DeadEnd[] {
    const surviving = new Set<string>();
    for (const s of this.files.values()) {
      for (const l of s.lines) if (l.origin.kind === "edit") surviving.add(l.origin.editId);
    }
    const lostEdits = new Set(
      this.input.events.flatMap((e) => (e.type === "edit" && this.lost.has(e.path) ? [e.id] : [])),
    );

    const out: DeadEnd[] = [];
    for (const [editId, origin] of this.inserted) {
      if (surviving.has(editId) || lostEdits.has(editId)) continue;
      let removedByEditId: string | undefined;
      let most = 0;
      for (const [by, n] of this.removals.get(editId) ?? []) {
        if (n > most) [removedByEditId, most] = [by, n];
      }
      out.push({
        editId,
        ...(origin.intentId ? { intentId: origin.intentId } : {}),
        ...(removedByEditId ? { removedByEditId } : {}),
      });
    }
    return out;
  }
}

// Same normalization as hunk content hashes (DB-07).
function normalize(text: string): string {
  return text.replace(/\s+$/, "").replace(/\s+/g, " ");
}

function splitLines(content: Buffer | null): string[] {
  if (content === null || content.length === 0) return [];
  const lines = content.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function hashOrNull(content: Buffer | null): string | null {
  return content === null ? null : hashContent(content);
}

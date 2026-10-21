// DB-08 spike: print every hunk of a session's diff with the intent mapping
// gave it, for a human to label correct / partly / wrong.
//
//   npx tsx scripts/mapping-report.ts [session-id-prefix] [--base <rev>] [--file-mode]
//
// Defaults to the newest session and diffs its base_sha against the working
// tree. Pass --base to scope a long session to one ticket's changes.
import { parseArgs } from "node:util";
import { targetContents } from "../src/diff/contents.js";
import { computeDiff, type Hunk } from "../src/diff/index.js";
import { mapHunks } from "../src/mapping/index.js";
import type { EventOf } from "../src/schema/events.js";
import { getBlob, hasBlob } from "../src/store/blobs.js";
import { findRepoRoot } from "../src/store/layout.js";
import { listSessions, readEvents } from "../src/store/read.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { base: { type: "string" }, "file-mode": { type: "boolean" } },
});

const root = findRepoRoot(process.cwd());
if (!root) fail("not inside a git repository");

const sessions = listSessions(root);
const session = positionals[0]
  ? sessions.find((s) => s.id.startsWith(positionals[0]!))
  : sessions[0];
if (!session)
  fail(positionals[0] ? `no session matching ${positionals[0]}` : "no sessions recorded");

const { events } = readEvents(root, session.id);
const base = values.base ?? session.baseSha;
if (!base) fail("session has no session_start; pass --base");

const spec = { kind: "worktree" as const, base };
const { hunks, stats } = computeDiff(root, spec);
const { byHunk, deadEnds } = mapHunks({
  hunks,
  events,
  contents: targetContents(root, spec),
  blob: (h) => (hasBlob(root, h) ? getBlob(root, h) : null),
  ...(values["file-mode"] ? { mode: "file" as const } : {}),
});

const intents = new Map<string, EventOf<"intent">>();
for (const e of events) if (e.type === "intent") intents.set(e.id, e);
const describe = (id: string) => {
  const i = intents.get(id);
  return i ? `${id} (${i.source}): ${oneLine(i.why, 160)}` : `${id} (unknown intent)`;
};

console.log(`session ${session.id}${session.ticket ? `  ticket ${session.ticket}` : ""}`);
console.log(
  `base ${base.slice(0, 12)}..worktree  ${stats.files} files, +${stats.insertions} -${stats.deletions}, ${hunks.length} hunks\n`,
);

hunks.forEach((h, n) => {
  const m = byHunk[h.id]!;
  console.log(`[${n + 1}] ${location(h)}  ${h.status}  (${m.mode} mode)  ${h.id}`);
  for (const l of h.lines.filter((l) => l.kind !== " ").slice(0, 4)) {
    console.log(`      ${l.kind} ${oneLine(l.text, 100)}`);
  }
  console.log(`    intent:   ${m.intentId ? describe(m.intentId) : "UNEXPLAINED"}`);
  for (const id of m.history) console.log(`    history:  ${describe(id)}`);
  if (m.externalTouched) console.log("    external: also changed outside the agent's edits");
  console.log("    label:    [ ] correct  [ ] partly  [ ] wrong\n");
});

const unexplained = hunks.filter((h) => byHunk[h.id]!.serves === "unexplained").length;
const fileMode = hunks.filter((h) => byHunk[h.id]!.mode === "file").length;
console.log(`unexplained: ${unexplained}/${hunks.length}   file mode: ${fileMode}/${hunks.length}`);
if (deadEnds.length > 0) {
  console.log("\ndead ends (edits with no surviving lines):");
  for (const d of deadEnds) {
    const by = d.removedByEditId ? `  removed by ${d.removedByEditId}` : "";
    console.log(`  ${d.editId}${by}  ${d.intentId ? describe(d.intentId) : "(no intent)"}`);
  }
}

function location(h: Hunk): string {
  const path = h.oldPath ? `${h.oldPath} -> ${h.path}` : h.path;
  if (h.lines.length === 0) return path;
  return h.newLines > 0
    ? `${path}:${h.newStart}-${h.newStart + h.newLines - 1}`
    : `${path}:${h.oldStart} (removed)`;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function fail(msg: string): never {
  console.error(`mapping-report: ${msg}`);
  process.exit(1);
}

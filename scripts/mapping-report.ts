// DB-08 spike: print every hunk of a diff with the intent mapping gave it,
// for a human to label correct / partly / wrong.
//
//   npx tsx scripts/mapping-report.ts [--worktree [base] | --commit <sha> | --range <a>..<b>] [--file-mode]
//
// Targets and session selection work as in the CLI (DB-09): with no flags,
// the working tree against its default base. Use --commit to label one
// ticket's commit.
import { parseArgs } from "node:util";
import { loadBriefingInputs } from "../src/briefing/inputs.js";
import type { Hunk } from "../src/diff/index.js";
import type { EventOf } from "../src/schema/events.js";
import { findRepoRoot } from "../src/store/layout.js";
import { TargetError, type TargetRequest } from "../src/target/index.js";

const { values } = parseArgs({
  options: {
    worktree: { type: "string" },
    commit: { type: "string" },
    range: { type: "string" },
    "file-mode": { type: "boolean" },
  },
});

const root = findRepoRoot(process.cwd());
if (!root) fail("not inside a git repository");

const req: TargetRequest = {
  ...(values.worktree !== undefined ? { worktree: values.worktree } : {}),
  ...(values.commit !== undefined ? { commit: values.commit } : {}),
  ...(values.range !== undefined ? { range: values.range } : {}),
};
let inputs;
try {
  inputs = loadBriefingInputs(root, req, values["file-mode"] ? { mode: "file" } : {});
} catch (err) {
  if (err instanceof TargetError) fail(err.message);
  throw err;
}
const { resolved, hunks, stats, sessionIds, events } = inputs;
const { byHunk, deadEnds } = inputs.mapping;

const intents = new Map<string, EventOf<"intent">>();
for (const e of events) if (e.type === "intent") intents.set(e.id, e);
const describe = (id: string) => {
  const i = intents.get(id);
  return i ? `${id} (${i.source}): ${oneLine(i.why, 160)}` : `${id} (unknown intent)`;
};

const { target } = resolved;
console.log(
  `${target.kind} ${target.base.slice(0, 12)}..${target.head === "WORKTREE" ? "worktree" : target.head.slice(0, 12)}` +
    `  briefing ${resolved.briefingId}`,
);
console.log(`sessions: ${sessionIds.length > 0 ? sessionIds.join(", ") : "none"}`);
console.log(
  `${stats.files} files, +${stats.insertions} -${stats.deletions}, ${hunks.length} hunks\n`,
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

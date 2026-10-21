// DB-04 spike: summarizes hook-logger output for one or more session dirs.
// usage: node scripts/spike/analyze.mjs <.diffbrief/spike/<session>> [...]
//
// Narration is looked up in the final transcript by tool_use_id, because the
// transcript lags behind PreToolUse/PostToolUse (it is current by PostToolBatch).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "user" || e.type === "assistant");
}

// Assistant text written after the previous tool result and before this tool_use.
function narrationFor(entries, toolUseId) {
  const idx = entries.findIndex(
    (e) =>
      Array.isArray(e.message?.content) &&
      e.message.content.some((b) => b.type === "tool_use" && b.id === toolUseId),
  );
  if (idx < 0) return null;
  const said = [];
  for (let i = idx; i >= 0; i--) {
    const e = entries[i];
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "user" && i !== idx) break;
    if (e.type === "assistant") {
      // Within the tool_use's own entry, only text before the tool_use counts.
      const upto = i === idx ? blocks.findIndex((b) => b.id === toolUseId) : blocks.length;
      said.unshift(
        ...blocks
          .slice(0, upto)
          .filter((b) => b.type === "text")
          .map((b) => b.text),
      );
    }
  }
  return said.join(" ").trim();
}

for (const dir of process.argv.slice(2)) {
  const records = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

  const main = readTranscript(
    records.find((r) => r.payload.transcript_path)?.payload.transcript_path,
  );
  const subagents = new Map();
  for (const r of records) {
    if (r.payload.agent_transcript_path)
      subagents.set(r.payload.agent_id, readTranscript(r.payload.agent_transcript_path));
  }

  console.log(`\n=== ${dir} (${records.length} hook calls)`);
  const edits = [];
  for (const r of records) {
    const p = r.payload;
    const tool = p.tool_name ? ` ${p.tool_name}` : "";
    const extra = [];
    if (p.agent_id) extra.push(`agent=${p.agent_type}/${p.agent_id.slice(0, 6)}`);
    if (p.hook_event_name === "PostToolUseFailure") extra.push(`error=${JSON.stringify(p.error)}`);
    if (p.hook_event_name === "SessionEnd") extra.push(`reason=${p.reason}`);
    if (
      p.hook_event_name === "PreToolUse" &&
      (EDIT_TOOLS.has(p.tool_name) || p.tool_name === "Bash")
    ) {
      const entries = p.agent_id ? (subagents.get(p.agent_id) ?? []) : main;
      const said = narrationFor(entries, p.tool_use_id);
      extra.push(
        `narration=${said === null ? "(tool_use not found)" : JSON.stringify(said.slice(0, 140))}`,
      );
      if (EDIT_TOOLS.has(p.tool_name))
        edits.push({ tool: p.tool_name, path: p.tool_input.file_path, said });
    }
    console.log(
      `${r.t_start} +${r.t_end - r.t_start}ms up=${r.process_uptime_ms}ms ${p.hook_event_name}${tool} ${extra.join(" ")}`,
    );
  }

  const withText = edits.filter((e) => e.said).length;
  console.log(`edits: ${edits.length}, with preceding text: ${withText}`);
  for (const e of edits) console.log(`  ${e.tool} ${e.path}\n    ${JSON.stringify(e.said)}`);

  // Hooks whose [start, end] windows overlap ran concurrently.
  let overlaps = 0;
  for (let i = 0; i < records.length; i++)
    for (let j = i + 1; j < records.length; j++)
      if (records[j].t_start < records[i].t_end) overlaps++;
  console.log(`overlapping hook calls: ${overlaps}`);
}

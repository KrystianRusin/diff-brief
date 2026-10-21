// DB-04 spike: turns one hook-logger session dir into a scrubbed test fixture
// for DB-05: payloads.jsonl (hook payloads in order) plus a filtered copy of
// the transcript(s). Keeps only user/assistant messages, drops system
// reminders and environment blocks, and rewrites local paths.
//
// usage: node scripts/spike/export-fixture.mjs <spike-session-dir> <repo-dir> <out-dir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const [sessionDir, repoDir, outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: export-fixture.mjs <spike-session-dir> <repo-dir> <out-dir>");

const scrub = (s) => s.split(repoDir).join("/repo").split(homedir()).join("/home/user");

function filterTranscript(path) {
  const keep = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line);
    if (e.type !== "user" && e.type !== "assistant") continue;
    const content = Array.isArray(e.message?.content)
      ? e.message.content
      : [{ type: "text", text: String(e.message?.content ?? "") }];
    const blocks = content.flatMap((b) => {
      if (b.type === "tool_use")
        return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
      if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        return [
          {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            is_error: !!b.is_error,
            content: text.slice(0, 2000),
          },
        ];
      }
      if (b.type === "text") {
        const text = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        if (!text || /^# Environment/.test(text)) return [];
        return [{ type: "text", text }];
      }
      return []; // thinking is empty (signature only), attachments are noise
    });
    if (!blocks.length) continue;
    keep.push({
      type: e.type,
      uuid: e.uuid,
      parentUuid: e.parentUuid,
      timestamp: e.timestamp,
      isSidechain: e.isSidechain,
      message: { role: e.message.role, content: blocks },
    });
  }
  return keep.map((e) => scrub(JSON.stringify(e))).join("\n") + "\n";
}

mkdirSync(join(outDir, "subagents"), { recursive: true });
const records = readdirSync(sessionDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(sessionDir, f), "utf8")));

let transcriptPath;
const payloads = records.map((r) => {
  const p = { ...r.payload };
  if (p.transcript_path) {
    transcriptPath ??= p.transcript_path;
    p.transcript_path = "transcript.jsonl";
  }
  if (p.agent_transcript_path) {
    const name = basename(p.agent_transcript_path);
    if (existsSync(r.payload.agent_transcript_path)) {
      writeFileSync(
        join(outDir, "subagents", name),
        filterTranscript(r.payload.agent_transcript_path),
      );
    }
    p.agent_transcript_path = `subagents/${name}`;
  }
  return scrub(JSON.stringify({ t: r.t_start, payload: p }));
});

writeFileSync(join(outDir, "payloads.jsonl"), payloads.join("\n") + "\n");
if (transcriptPath)
  writeFileSync(join(outDir, "transcript.jsonl"), filterTranscript(transcriptPath));
console.log(`wrote ${outDir} (${payloads.length} payloads) from ${dirname(sessionDir)}`);

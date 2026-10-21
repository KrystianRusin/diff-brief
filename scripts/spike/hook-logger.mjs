// DB-04 spike: dumps every raw Claude Code hook payload to
// <project>/.diffbrief/spike/<session_id>/<ts>-<pid>-<event>.json, plus the
// transcript tail at that moment so we can tell what was already flushed.
// Throwaway code: never fails, never prints, always exits 0.
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tStart = Date.now();
const TAIL_BYTES = 256 * 1024;
const TAIL_LINES = 12;

function transcriptTail(path) {
  try {
    const { size } = statSync(path);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // First line may be cut mid-record when we didn't read from the start.
    if (len < size) lines.shift();
    return { size, lines: lines.slice(-TAIL_LINES).map((l) => JSON.parse(l)) };
  } catch (err) {
    return { error: String(err) };
  }
}

try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const event = payload.hook_event_name ?? "unknown";

  const record = {
    t_start: tStart,
    process_uptime_ms: Math.round(process.uptime() * 1000),
    pid: process.pid,
    ppid: process.ppid,
    env: { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR },
    payload,
    transcript: payload.transcript_path ? transcriptTail(payload.transcript_path) : null,
  };
  record.t_end = Date.now();

  const project = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
  const dir = join(project, ".diffbrief", "spike", String(payload.session_id ?? "no-session"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${tStart}-${process.pid}-${event}.json`),
    JSON.stringify(record, null, 2),
  );
} catch {
  // spike logger must never affect the agent
}

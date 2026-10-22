import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capture } from "../../src/adapters/claude-code/capture.js";
import { eventsPath } from "../../src/store/layout.js";
import { makeTempRepo, type TempRepo } from "./temp-repo.js";

// Replays a DB-04 fixture (recorded hook payloads + transcript) through the
// capture adapter as if Claude Code were running it in a fresh repo.

const FIXTURES = join(import.meta.dirname, "../fixtures/claude-code/payloads");
const FIXTURE_ROOT = "/repo";

// What `diffbrief init` registers, with matchers.
const REGISTERED: Record<string, RegExp | null> = {
  SessionStart: null,
  UserPromptSubmit: null,
  PostToolUse: /^(Edit|Write|MultiEdit|NotebookEdit)$/,
  PostToolUseFailure: /^Bash$/,
  PostToolBatch: null,
  TaskCreated: null,
  SubagentStop: null,
  Stop: null,
  SessionEnd: null,
};

type Recorded = { t: number; payload: Record<string, unknown> };
type TranscriptFile = { rel: string; lines: { ts: number; raw: string }[]; flushed: number };

export type ReplayOptions = {
  // Run before the payload with this tool_use_id is delivered, e.g. to
  // reproduce what a Bash command did to the working tree.
  sideEffects?: Record<string, (repo: TempRepo) => void>;
};

export type ReplayResult = {
  repo: TempRepo;
  transcriptDir: string;
  sessionId: string;
  lines: string[];
  // Our-code time per delivered hook, in ms.
  timings: { event: string; ms: number }[];
  cleanup(): void;
};

// What Bash commands in the recordings did to the working tree, which the
// payloads don't capture. subagent-tasks had one append to src/cart.js,
// standing in for a formatter.
const FIXTURE_SIDE_EFFECTS: Record<string, ReplayOptions["sideEffects"]> = {
  "subagent-tasks": {
    toolu_01Use6aig3iZRuc325bdrjkS: (repo) =>
      appendFileSync(join(repo.dir, "src/cart.js"), "// touched by script\n"),
  },
};

export function replayFixture(name: string, opts: ReplayOptions = {}): ReplayResult {
  const dir = join(FIXTURES, name);
  const recorded = readJsonl<Recorded>(join(dir, "payloads.jsonl"));
  const repo = makeTempRepo();
  const transcriptDir = mkdtempSync(join(tmpdir(), "diffbrief-transcript-"));
  const relocate = (s: string) => s.split(FIXTURE_ROOT).join(repo.dir);

  seedRepo(repo, recorded);
  const transcripts = transcriptFiles(dir);
  const sideEffects = new Map(Object.entries(opts.sideEffects ?? FIXTURE_SIDE_EFFECTS[name] ?? {}));
  const timings: ReplayResult["timings"] = [];
  let sessionId = "";

  for (const { t, payload } of recorded) {
    // Lines the agent had written by the time this hook fired.
    for (const f of transcripts) {
      const dest = join(transcriptDir, f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      while (f.flushed < f.lines.length && f.lines[f.flushed]!.ts <= t) {
        appendFileSync(dest, relocate(f.lines[f.flushed]!.raw) + "\n");
        f.flushed++;
      }
    }

    const toolUseId = payload.tool_use_id as string | undefined;
    const effect = toolUseId && sideEffects.get(toolUseId);
    if (effect) {
      sideEffects.delete(toolUseId);
      effect(repo);
    }

    const event = payload.hook_event_name as string;
    if (!(event in REGISTERED)) continue;
    const matcher = REGISTERED[event];
    if (matcher && !matcher.test(String(payload.tool_name))) continue;
    if (event === "PostToolUse") applyEdit(repo, payload);

    const delivered = JSON.parse(relocate(JSON.stringify(payload))) as Record<string, unknown>;
    for (const key of ["transcript_path", "agent_transcript_path"]) {
      if (typeof delivered[key] === "string") delivered[key] = join(transcriptDir, delivered[key]);
    }
    sessionId = delivered.session_id as string;

    const start = process.hrtime.bigint();
    capture(delivered, { now: () => new Date(t).toISOString() });
    timings.push({ event, ms: Number(process.hrtime.bigint() - start) / 1e6 });
  }

  const path = eventsPath(repo.dir, sessionId);
  const lines = existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : [];
  return {
    repo,
    transcriptDir,
    sessionId,
    lines,
    timings,
    cleanup() {
      repo.cleanup();
      rmSync(transcriptDir, { recursive: true, force: true });
    },
  };
}

// Recreate the files as they were when the run started, from the first
// sighting of each in a Read result or an edit's originalFile. Then commit,
// since the hook needs a base commit.
function seedRepo(repo: TempRepo, recorded: Recorded[]): void {
  const seen = new Set<string>();
  for (const { payload } of recorded) {
    if (payload.hook_event_name !== "PostToolUse") continue;
    const res = (payload.tool_response ?? {}) as Record<string, unknown>;
    const file = res.file as { filePath?: string; content?: string } | undefined;
    // originalFile null = the file didn't exist yet, which also counts.
    const editPath = (payload.tool_input as { file_path?: string }).file_path;
    const sighting =
      payload.tool_name === "Read" && file?.filePath && typeof file.content === "string"
        ? { path: file.filePath, content: file.content }
        : editPath && "originalFile" in res
          ? {
              path: editPath,
              content: typeof res.originalFile === "string" ? res.originalFile : null,
            }
          : null;
    if (!sighting || seen.has(sighting.path)) continue;
    seen.add(sighting.path);
    if (sighting.content !== null) {
      repo.write(sighting.path.slice(FIXTURE_ROOT.length + 1), sighting.content);
    }
  }
  repo.write(".gitignore", ".diffbrief/\n");
  // Dated before the recording, as a real base commit would be, so session
  // selection (DB-09) doesn't take the session for work the base contains.
  repo.commit("base", new Date((recorded[0]?.t ?? Date.now()) - 60_000));
}

// Do to the working tree what the tool did, before its PostToolUse fires.
function applyEdit(repo: TempRepo, payload: Record<string, unknown>): void {
  const input = payload.tool_input as Record<string, unknown>;
  const rel = String(input.file_path).slice(FIXTURE_ROOT.length + 1);
  const full = join(repo.dir, rel);
  if (payload.tool_name === "Write") return repo.write(rel, String(input.content));
  let text = readFileSync(full, "utf8");
  const edits =
    payload.tool_name === "MultiEdit"
      ? (input.edits as Record<string, unknown>[])
      : [input as Record<string, unknown>];
  for (const e of edits) {
    const from = String(e.old_string);
    const to = String(e.new_string);
    text = e.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  }
  repo.write(rel, text);
}

function transcriptFiles(dir: string): TranscriptFile[] {
  const rels = ["transcript.jsonl"];
  const sub = join(dir, "subagents");
  if (existsSync(sub)) rels.push(...readdirSync(sub).map((f) => `subagents/${f}`));
  return rels.map((rel) => {
    let last = 0;
    const lines = readFileSync(join(dir, rel), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((raw) => {
        const ts = Date.parse((JSON.parse(raw) as { timestamp?: string }).timestamp ?? "");
        last = Number.isFinite(ts) ? ts : last;
        return { ts: last, raw };
      });
    return { rel, lines, flushed: 0 };
  });
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

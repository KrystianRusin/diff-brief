import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { capture } from "../../src/adapters/claude-code/capture.js";
import { parseEvent, type Event, type EventOf } from "../../src/schema/events.js";
import { eventsPath, statePath } from "../../src/store/layout.js";
import { replayFixture, type ReplayResult } from "../helpers/replay.js";
import { makeTempRepo, type TempRepo } from "../helpers/temp-repo.js";

const EXPECTED = join(import.meta.dirname, "../fixtures/claude-code/expected");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const runs: ReplayResult[] = [];
afterEach(() => runs.splice(0).forEach((r) => r.cleanup()));

function replay(name: string) {
  const run = replayFixture(name);
  runs.push(run);
  const events = run.lines.map((l) => parseEvent(JSON.parse(l)));
  return { run, events };
}

// Stable across runs: temp dirs and the base commit sha differ every time.
function normalize(run: ReplayResult): string {
  return (
    run.lines
      .map((l) =>
        l
          .split(run.repo.dir)
          .join("/repo")
          .split(run.transcriptDir)
          .join("/transcripts")
          .replace(/"base_sha":"[0-9a-f]+"/, '"base_sha":"<base>"'),
      )
      .join("\n") + "\n"
  );
}

function of<T extends Event["type"]>(events: Event[], type: T): EventOf<T>[] {
  return events.filter((e): e is EventOf<T> => e.type === type);
}

// edit id → intent, with edit_link events applied the way readers will.
function intentsByEdit(events: Event[]): Map<string, EventOf<"intent">> {
  const intents = new Map(of(events, "intent").map((i) => [i.id, i]));
  const result = new Map<string, EventOf<"intent">>();
  for (const e of of(events, "edit")) if (e.intent_id) result.set(e.id, intents.get(e.intent_id)!);
  for (const l of of(events, "edit_link")) result.set(l.edit_id, intents.get(l.intent_id)!);
  return result;
}

const suffix = (id: string) => (e: { id: string }) => e.id.endsWith(id);

describe.each(["bugfix-basic", "subagent-tasks", "tool-failures"])("replay %s", (name) => {
  test("matches the golden events.jsonl", () => {
    const { run } = replay(name);
    const golden = join(EXPECTED, `${name}.events.jsonl`);
    if (UPDATE || !existsSync(golden)) {
      mkdirSync(EXPECTED, { recursive: true });
      writeFileSync(golden, normalize(run));
    }
    expect(normalize(run)).toBe(readFileSync(golden, "utf8"));
  });

  test("every edit ends up with an intent, and nothing was logged as an error", () => {
    const { run, events } = replay(name);
    const linked = intentsByEdit(events);
    for (const e of of(events, "edit")) expect(linked.get(e.id), e.id).toBeDefined();
    expect(existsSync(join(run.repo.dir, ".diffbrief/logs/hook.log"))).toBe(false);
  });

  test("our-code time stays within the DB-05 budget", () => {
    const { run } = replay(name);
    const budget = (event: string) =>
      event === "PostToolUse" ? 30 : event === "PostToolBatch" ? 50 : 15;
    // Session start and end spawn git several times; DB-05's budget is for
    // per-tool-call events, so those two get the batch budget.
    const limit = (event: string) =>
      event === "SessionStart" || event === "SessionEnd" ? 50 : budget(event);
    for (const t of run.timings) expect(t.ms, t.event).toBeLessThan(limit(t.event));
  });
});

describe("fixture specifics", () => {
  test("bugfix-basic: exit codes come from the transcript when no failure hook fired", () => {
    const { events } = replay("bugfix-basic");
    const commands = of(events, "command");
    expect(commands.find(suffix("3HHSyA"))).toMatchObject({ exit: 0, kind: "test" });
    // Rejected before running (multiple operations), so no exit code exists.
    expect(commands.find(suffix("3BY9Fm"))?.exit).toBe(-1);
    expect(commands.find(suffix("Z5tVBd"))?.exit).toBe(3);
    // Neither Write was narrated; both fall back to the prompt.
    const linked = intentsByEdit(events);
    for (const e of of(events, "edit")) expect(linked.get(e.id)?.source).toBe("prompt");
  });

  test("subagent-tasks: narration, plan steps, subagent edits, script changes", () => {
    const { events } = replay("subagent-tasks");
    const linked = intentsByEdit(events);
    const edits = of(events, "edit");
    const intentFor = (id: string) => linked.get(edits.find(suffix(id))!.id);

    expect(intentFor("aViTc8")).toMatchObject({ source: "narration" });
    expect(intentFor("aViTc8")?.why).toMatch(/^The test failed as intended/);
    const link = of(events, "edit_link").find((l) => l.edit_id.endsWith("aViTc8"));
    const message = of(events, "agent_message").find((m) => m.id === link?.msg_ref);
    expect(message?.text).toMatch(/Correcting it to 90/);

    expect(intentFor("fjZ5bS")).toMatchObject({ id: "p2", source: "plan_step" });
    expect(intentFor("S9yv1U")).toMatchObject({ id: "p3", source: "plan_step" });

    const sub = edits.find(suffix("nJF1ep"));
    expect(sub).toMatchObject({ path: "src/format.js", agent_id: "a1e3a1bff96fe0132" });
    expect(intentFor("nJF1ep")).toMatchObject({ id: "p1" });

    const external = of(events, "external_change");
    expect(external.map((e) => e.path)).toEqual(["src/cart.js"]);
  });

  test("tool-failures: failed command, failed read, rejected edit", () => {
    const { events } = replay("tool-failures");
    expect(of(events, "command").find(suffix("sHmxdu"))).toMatchObject({
      exit: 3,
      duration_ms: 224,
    });
    expect(of(events, "read")).toEqual([]); // the only Read failed
    expect(of(events, "edit")).toEqual([]); // the Edit failed validation, no hook fired
  });
});

describe("live behaviour", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  const SESSION = "11111111-2222-3333-4444-555555555555";
  const send = (payload: Record<string, unknown>) =>
    capture({ session_id: SESSION, cwd: repo.dir, transcript_path: "/nonexistent", ...payload });
  const events = () =>
    readFileSync(eventsPath(repo.dir, SESSION), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => parseEvent(JSON.parse(l)));

  function writeEdit(id: string, path: string, content: string, original: string | null) {
    writeFileSync(join(repo.dir, path), content);
    send({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_use_id: id,
      tool_input: { file_path: join(repo.dir, path), content },
      tool_response: { type: original === null ? "create" : "update", originalFile: original },
    });
  }

  test("a manual edit between agent edits is an external_change", () => {
    repo = makeTempRepo();
    repo.write("a.txt", "one\n");
    repo.commit("base");
    send({ hook_event_name: "SessionStart", source: "startup" });
    send({ hook_event_name: "UserPromptSubmit", prompt: "change a" });

    writeEdit("t1", "a.txt", "two\n", "one\n");
    // The user edits the file by hand; the agent's next edit sees it.
    writeEdit("t2", "a.txt", "three\n", "two (hand edited)\n");

    const types = events().map((e) => e.type);
    expect(types).toEqual(["session_start", "edit", "external_change", "edit"]);
    const ext = of(events(), "external_change")[0]!;
    const edits = of(events(), "edit");
    expect(ext.before_hash).toBe(edits[0]!.after_hash);
    expect(ext.after_hash).toBe(edits[1]!.before_hash);
  });

  test("a resumed session doesn't write a second session_start", () => {
    repo = makeTempRepo();
    repo.commit("base");
    send({ hook_event_name: "SessionStart", source: "startup" });
    send({ hook_event_name: "UserPromptSubmit", prompt: "first" });
    send({ hook_event_name: "SessionStart", source: "resume" });
    send({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    expect(events().map((e) => e.type)).toEqual(["session_start", "prompt"]);
    expect(of(events(), "session_start")[0]?.prompt).toBe("first");
  });

  test("ticket comes from the branch name", () => {
    repo = makeTempRepo();
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feat/db-42-thing");
    send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    expect(of(events(), "session_start")[0]).toMatchObject({
      branch: "feat/db-42-thing",
      ticket: "DB-42",
    });
  });
});

describe("never fails the agent", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  const garbage: unknown[] = [
    {},
    { hook_event_name: "PostToolUse" },
    { hook_event_name: "PostToolUse", session_id: "../../etc", cwd: "/" },
    { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Write", tool_input: 5 },
    { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Edit", tool_use_id: "x" },
    { hook_event_name: "PostToolBatch", session_id: "s", transcript_path: 42 },
    { hook_event_name: "Nope", session_id: "s" },
    { hook_event_name: "SessionEnd", session_id: "s", reason: { a: 1 } },
    { hook_event_name: "TaskCreated", session_id: "s", task_id: null },
  ];

  test("malformed payloads and a corrupt state file don't throw", () => {
    repo = makeTempRepo();
    repo.commit("base");
    mkdirSync(join(repo.dir, ".diffbrief/sessions/s"), { recursive: true });
    writeFileSync(statePath(repo.dir, "s"), "{ corrupt");
    for (const p of garbage) {
      expect(() => capture({ cwd: repo.dir, ...(p as object) })).not.toThrow();
    }
    // Random byte soup as field values.
    for (let i = 0; i < 200; i++) {
      const junk = () =>
        [null, 0, -1, "", "x".repeat(i), [], {}, true, "/etc/passwd"][(i * 7 + 3) % 9];
      const payload = {
        cwd: repo.dir,
        session_id: "s",
        hook_event_name: ["PostToolUse", "PostToolBatch", "Stop", "SessionEnd"][i % 4],
        tool_name: ["Write", "Edit", "Bash", junk()][i % 4],
        tool_use_id: junk(),
        tool_input: { file_path: junk(), content: junk() },
        tool_response: { originalFile: junk() },
        transcript_path: junk(),
      };
      expect(() => capture(payload)).not.toThrow();
    }
  });

  test("the CLI exits 0 and prints nothing for bad input", () => {
    repo = makeTempRepo();
    repo.commit("base");
    const run = (input: string) =>
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "hook", "claude-code"], {
        input,
        encoding: "utf8",
        env: { ...process.env, DIFFBRIEF_DISABLE: "" },
      });
    expect(run("not json")).toBe("");
    expect(run("[1,2]")).toBe("");
    expect(run(JSON.stringify({ hook_event_name: "Stop", cwd: repo.dir, session_id: "s" }))).toBe(
      "",
    );
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { buildContextPacks, splitEpisodes, type Episode } from "../../src/enrich/index.js";
import { parseEvent, type Event } from "../../src/schema/events.js";
import { getBlob, hashContent, hasBlob } from "../../src/store/blobs.js";
import { mergeSessions, type MergedEvent } from "../../src/target/index.js";
import { replayFixture, type ReplayResult } from "../helpers/replay.js";

const runs: ReplayResult[] = [];
afterEach(() => runs.splice(0).forEach((r) => r.cleanup()));

// Ids without the session prefix, to keep expectations readable.
const bare = (id: string) => id.slice(id.indexOf(":") + 1);
const shape = (ep: Episode) => ({
  ...(ep.agent_id ? { agent: ep.agent_id } : {}),
  messages: ep.message_ids.map(bare),
  edits: ep.edit_ids.map(bare),
  commands: ep.command_ids.map(bare),
  reads: ep.read_paths,
  steps: ep.plan_step_ids.map(bare),
});

function fixture(name: string) {
  const run = replayFixture(name);
  runs.push(run);
  const events = run.lines.map((l) => parseEvent(JSON.parse(l)));
  const merged = mergeSessions([{ id: run.sessionId, events }]).events;
  const root = run.repo.dir;
  return { events: merged, blob: (h: string) => (hasBlob(root, h) ? getBlob(root, h) : null) };
}

// Boundaries checked by hand against the recordings.
describe("recorded sessions", () => {
  test("bugfix-basic: one episode; the rerun and the summary have no edits", () => {
    const { events, blob } = fixture("bugfix-basic");
    const episodes = splitEpisodes(events);
    expect(episodes.map(shape)).toEqual([
      {
        messages: ["m1"],
        edits: ["toolu_01Lds2eB5spK1wnz9ZkyEZHM", "toolu_01XnVjCCMncGEo48yfp6qZA6"],
        // The test is followed by another command, so the episode stays open
        // until the next statement (m2).
        commands: ["toolu_013v6zuWgZypWRL1N93HHSyA", "toolu_01Fgw6iecygbTb328m3BY9Fm"],
        reads: ["src/order.js", "package.json", "src/cart.js", "test/**", "test/cart.test.js"],
        steps: [],
      },
    ]);

    const [pack] = buildContextPacks(events, episodes, { blob });
    expect(pack!.priorMessages.map((m) => bare(m.id))).toEqual(["m1"]);
    expect(pack!.prompts).toHaveLength(1);
    expect(pack!.commandsAfter).toEqual([
      { cmd: "npm test 2>&1 | tail -15", exit: 0, kind: "test" },
      { cmd: 'node -e "process.exit(3)"; echo "exit code: $?"', exit: -1, kind: "other" },
    ]);
    expect(pack!.edits[1]!.unifiedDiff).toMatch(
      /^--- \/dev\/null\n\+\+\+ b\/test\/order.test.js\n@@ /,
    );
    expect(pack!.truncated).toBeUndefined();
  });

  test("subagent-tasks: the subagent gets its own episode, the test closes the main one", () => {
    const { events, blob } = fixture("subagent-tasks");
    const episodes = splitEpisodes(events);
    expect(episodes.map(shape)).toEqual([
      {
        messages: [],
        edits: ["toolu_01ErQhEBeQvJYGAKoLfjZ5bS", "toolu_01Ry2hpy5Y8LtkWftFS9yv1U"],
        commands: [
          "toolu_01PJjMqKzLa2vBdJYHC7DkZG",
          "toolu_01Lga3ukBm1Th6riNpS3JyCf",
          "toolu_01Ve6CaqRPvcY7iSiZy4CKtj",
        ],
        reads: [],
        steps: ["p2", "p3"],
      },
      {
        agent: "a1e3a1bff96fe0132",
        messages: [],
        edits: ["toolu_01HpR9rvZcCSfosdRMnJF1ep"],
        commands: ["toolu_018sadgXpBjhxJn6Bc3bLdsg"],
        reads: ["src/cart.js"],
        steps: ["p1"],
      },
      {
        messages: ["m2"],
        edits: ["toolu_01EauZvTMvDga9Djc8aViTc8"],
        commands: ["toolu_01NrqTUgvfCg9PzkDgzRUDR7", "toolu_01Use6aig3iZRuc325bdrjkS"],
        reads: [],
        // Narrated, and made while p3 was in progress.
        steps: ["p3"],
      },
    ]);

    const packs = buildContextPacks(events, episodes, { blob });
    expect(packs[2]!.priorMessages.map((m) => bare(m.id))).toEqual(["m2"]);
    expect(packs[2]!.edits[0]!.planStep).toBe(episodes[2]!.plan_step_ids[0]);
    expect(packs[0]!.plan.map((p) => bare(p.id))).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("ids hold across re-runs", () => {
    const a = splitEpisodes(fixture("subagent-tasks").events).map((e) => e.id);
    const b = splitEpisodes(fixture("subagent-tasks").events).map((e) => e.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

// A hand-written log. Each helper appends one event a second after the last;
// ids number events by position, so e5 is the fifth event.
function log() {
  const events: Event[] = [];
  const blobs = new Map<string, Buffer>();
  let clock = Date.parse("2026-10-21T10:00:00Z");
  let n = 0;
  const ts = () => new Date((clock += 1000)).toISOString();
  const snap = (c: string) => {
    const h = hashContent(c);
    blobs.set(h, Buffer.from(c));
    return h;
  };
  const b = {
    events,
    blobs,
    msg(text = "statement", agent?: string) {
      const id = `m${++n}`;
      events.push({ v: 1, type: "agent_message", ts: ts(), id, text, ...ag(agent) });
      return b;
    },
    read(path: string) {
      n++;
      events.push({ v: 1, type: "read", ts: ts(), path });
      return b;
    },
    edit(
      path: string,
      opts: { step?: string; agent?: string; before?: string; after?: string } = {},
    ) {
      const id = `e${++n}`;
      events.push({
        v: 1,
        type: "edit",
        ts: ts(),
        id,
        path,
        tool: "Edit",
        before_hash: snap(opts.before ?? "a\n"),
        after_hash: snap(opts.after ?? "b\n"),
        ...(opts.step ? { intent_id: opts.step } : {}),
        ...ag(opts.agent),
      });
      return b;
    },
    cmd(kind: "test" | "build" | "other" = "other", agent?: string) {
      const id = `c${++n}`;
      const cmd = kind === "other" ? "ls" : `npm run ${kind}`;
      events.push({
        v: 1,
        type: "command",
        ts: ts(),
        id,
        cmd,
        exit: 0,
        duration_ms: 1,
        kind,
        ...ag(agent),
      });
      return b;
    },
    plan(...ids: string[]) {
      for (const id of ids) {
        n++;
        events.push({ v: 1, type: "intent", ts: ts(), id, why: `step ${id}`, source: "plan_step" });
      }
      return b;
    },
    merged(): MergedEvent[] {
      return mergeSessions([{ id: "sess0001", events }]).events;
    },
  };
  return b;
}

const ag = (agent?: string) => (agent ? { agent_id: agent } : {});
const editsOf = (eps: Episode[]) => eps.map((e) => e.edit_ids.map(bare));

describe("splitting rules", () => {
  test("a statement after an edit or command starts a new episode", () => {
    const l = log().msg().read("a").edit("a").msg().edit("b").cmd().msg().edit("c");
    expect(editsOf(splitEpisodes(l.merged()))).toEqual([["e3"], ["e5"], ["e8"]]);
  });

  test("statements before any edit stay in the same episode", () => {
    const l = log().msg().msg().read("a").edit("a").edit("b");
    const [ep] = splitEpisodes(l.merged());
    expect(ep!.message_ids.map(bare)).toEqual(["m1", "m2"]);
    expect(ep!.edit_ids.map(bare)).toEqual(["e4", "e5"]);
  });

  test("a test or build closes the episode unless another command follows", () => {
    const l = log().edit("a").cmd("test").edit("b").cmd("build").cmd("other").edit("c");
    expect(editsOf(splitEpisodes(l.merged()))).toEqual([["e1"], ["e3", "e6"]]);
  });

  test("each session and each agent splits on its own", () => {
    const l = log().msg().edit("a").msg("sub", "sub1").edit("b", { agent: "sub1" }).edit("c");
    const eps = splitEpisodes(l.merged());
    expect(eps.map((e) => [e.agent_id, e.edit_ids.map(bare)])).toEqual([
      [undefined, ["e2", "e5"]],
      ["sub1", ["e4"]],
    ]);

    const s1 = log().edit("a");
    const s2 = log().edit("b");
    const merged = mergeSessions([
      { id: "sess0001", events: s1.events },
      { id: "sess0002", events: s2.events },
    ]).events;
    expect(splitEpisodes(merged).map((e) => e.session_id)).toEqual(["sess0001", "sess0002"]);
  });

  test("events are ordered by time, not by log position", () => {
    // The adapter writes an edit from its hook before the transcript walk
    // writes the statement that came first.
    const l = log().msg().edit("a");
    const [m, e] = l.events as [Event, Event];
    const merged = mergeSessions([{ id: "sess0001", events: [e, m] }]).events;
    const [ep] = splitEpisodes(merged);
    expect(ep!.message_ids.map(bare)).toEqual(["m1"]);
    expect(ep!.start_ts).toBe(m.ts);
  });
});

describe("regrouping by plan step", () => {
  test("an episode over the file limit splits by plan step", () => {
    const l = log().plan("p1", "p2").msg("doing both");
    for (const f of ["a", "b", "c", "d"]) l.edit(f, { step: "p1" });
    l.cmd("other");
    for (const f of ["e", "f", "g"]) l.edit(f, { step: "p2" });
    l.cmd("other");
    const eps = splitEpisodes(l.merged());
    expect(eps.map(shape)).toEqual([
      {
        messages: ["m3"],
        edits: ["e4", "e5", "e6", "e7"],
        commands: ["c8"],
        reads: [],
        steps: ["p1"],
      },
      { messages: [], edits: ["e9", "e10", "e11"], commands: ["c12"], reads: [], steps: ["p2"] },
    ]);
  });

  test("under the limit, or with no plan steps, the episode stays whole", () => {
    const small = log().plan("p1", "p2").edit("a", { step: "p1" }).edit("b", { step: "p2" });
    expect(editsOf(splitEpisodes(small.merged()))).toEqual([["e3", "e4"]]);

    const untied = log();
    for (const f of "abcdefgh") untied.edit(f);
    expect(splitEpisodes(untied.merged())).toHaveLength(1);
    expect(splitEpisodes(untied.merged(), { maxFiles: 2 })).toHaveLength(1);
  });

  test("episodes alternating between files regroup by plan step", () => {
    const l = log().plan("p1", "p2");
    l.msg().edit("a", { step: "p1" }).msg().edit("b", { step: "p2" });
    l.msg().edit("a", { step: "p1" }).msg().edit("b", { step: "p2" });
    const eps = splitEpisodes(l.merged());
    expect(eps.map(shape)).toEqual([
      { messages: ["m3", "m7"], edits: ["e4", "e8"], commands: [], reads: [], steps: ["p1"] },
      { messages: ["m5", "m9"], edits: ["e6", "e10"], commands: [], reads: [], steps: ["p2"] },
    ]);
  });

  test("iterating on one file is not alternating", () => {
    const l = log().plan("p1");
    l.msg()
      .edit("a", { step: "p1" })
      .msg()
      .edit("a", { step: "p1" })
      .msg()
      .edit("a", { step: "p1" });
    expect(splitEpisodes(l.merged())).toHaveLength(3);
  });

  test("edits with no plan step keep their own episode", () => {
    const l = log().plan("p1");
    l.msg().edit("a", { step: "p1" }).msg().edit("b").msg().edit("a", { step: "p1" });
    expect(editsOf(splitEpisodes(l.merged()))).toEqual([["e3", "e7"], ["e5"]]);
  });
});

describe("context pack", () => {
  const blobOf = (l: ReturnType<typeof log>) => (h: string) => l.blobs.get(h) ?? null;

  test("keeps the last 3 statements before the first edit", () => {
    const l = log().msg("one").msg("two").msg("three").msg("four").edit("a");
    const [pack] = buildContextPacks(l.merged(), splitEpisodes(l.merged()), { blob: blobOf(l) });
    expect(pack!.priorMessages.map((m) => m.text)).toEqual(["two", "three", "four"]);
  });

  test("a subagent's pack includes the main agent's statements", () => {
    const l = log().msg("delegating").msg("sub starts", "s1").edit("a", { agent: "s1" });
    const [pack] = buildContextPacks(l.merged(), splitEpisodes(l.merged()), { blob: blobOf(l) });
    expect(pack!.priorMessages.map((m) => m.text)).toEqual(["delegating", "sub starts"]);
  });

  test("marks dead ends and edits whose contents weren't stored", () => {
    const l = log().edit("a").edit("b", { after: "c\n" });
    const events = l.merged();
    const lost = events[1] as Extract<MergedEvent, { type: "edit" }>;
    l.blobs.delete(lost.after_hash!);
    const [pack] = buildContextPacks(events, splitEpisodes(events), {
      blob: blobOf(l),
      deadEnds: [events[0]!.type === "edit" ? events[0]!.id : ""],
    });
    expect(pack!.edits.map((e) => [e.deadEnd, e.unifiedDiff])).toEqual([
      [true, "--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-a\n+b"],
      [undefined, "(contents not recorded)"],
    ]);
  });

  test("caps each diff at 200 body lines, keeping hunk headers", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const l = log().edit("a", { before: "", after: big });
    const [pack] = buildContextPacks(l.merged(), splitEpisodes(l.merged()), {
      blob: blobOf(l),
      maxTokens: Infinity,
    });
    const diff = pack!.edits[0]!.unifiedDiff.split("\n");
    expect(diff.slice(0, 3)).toEqual(["--- a/a", "+++ b/a", "@@ -0,0 +1,500 @@"]);
    expect(diff.filter((x) => x.startsWith("+line"))).toHaveLength(200);
    expect(diff.at(-1)).toBe("… 300 lines omitted");
    expect(pack!.truncated).toBeUndefined();
  });

  test("stays under the token budget: diffs shrink first, then older messages go", () => {
    const body = (tag: string) =>
      Array.from({ length: 150 }, (_, i) => `${tag} ${i} ${"x".repeat(60)}`).join("\n") + "\n";
    const l = log();
    for (let i = 0; i < 5; i++) l.msg(`statement ${i} ${"y".repeat(2000)}`);
    for (const f of ["a", "b", "c"]) l.edit(f, { before: body("old"), after: body("new") });
    const events = l.merged();
    const episodes = splitEpisodes(events);

    const [pack] = buildContextPacks(events, episodes, { blob: blobOf(l) });
    const tokens = JSON.stringify(pack).length / 4;
    expect(tokens).toBeLessThanOrEqual(6000);
    expect(pack!.truncated).toBe(true);
    for (const e of pack!.edits)
      expect(e.unifiedDiff).toMatch(/^--- a\/\w\n\+\+\+ b\/\w\n@@ -1,150 \+1,150 @@/);
    // Three 2k-char messages fit once the diffs are down to headers.
    expect(pack!.priorMessages).toHaveLength(3);

    const [tight] = buildContextPacks(events, episodes, { blob: blobOf(l), maxTokens: 1000 });
    expect(tight!.edits.every((e) => e.unifiedDiff.split("\n").length === 4)).toBe(true);
    expect(tight!.priorMessages.map((m) => m.text.slice(0, 11))).toEqual(["statement 4"]);
  });
});

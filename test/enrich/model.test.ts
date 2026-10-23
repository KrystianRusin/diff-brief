import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadBriefingInputs } from "../../src/briefing/inputs.js";
import { targetContents } from "../../src/diff/contents.js";
import type { Hunk } from "../../src/diff/index.js";
import {
  buildContextPacks,
  enrichDeterministic,
  enrichModel,
  PROMPT_VERSION,
  splitEpisodes,
  type ContextPack,
  type Episode,
} from "../../src/enrich/index.js";
import { finishBriefing } from "../../src/enrich/model/briefing.js";
import { buildConcepts, orderByDataFlow } from "../../src/enrich/model/concepts.js";
import { groundIntents, type IntentsReply } from "../../src/enrich/model/intents.js";
import { checkLinks, importRelation } from "../../src/enrich/model/links.js";
import {
  BRIEFING_SYSTEM,
  CONCEPTS_SYSTEM,
  DRIFT_SYSTEM,
  INTENTS_SYSTEM,
  LINKS_SYSTEM,
} from "../../src/enrich/model/prompts.js";
import { LlmError, type LlmProvider } from "../../src/llm/index.js";
import { parseAnnotations } from "../../src/schema/annotations.js";
import { getBlob, hasBlob } from "../../src/store/blobs.js";
import { replayFixture, type ReplayResult } from "../helpers/replay.js";

type Intent = IntentsReply["intents"][number];

// An episode with a statement, an edit, a second statement, a second edit:
// m1 (t=1) e1 (t=2) m2 (t=3) e2 (t=4), plus plan step p1 (t=0).
const episode: Episode = {
  id: "ep-1",
  session_id: "sess0001-aaaa",
  start_ts: "2026-10-21T10:00:01Z",
  end_ts: "2026-10-21T10:00:04Z",
  message_ids: ["m1", "m2"],
  edit_ids: ["e1", "e2"],
  command_ids: [],
  read_paths: [],
  plan_step_ids: [],
};
const times = new Map(Object.entries({ p1: 0, m1: 1, e1: 2, m2: 3, e2: 4 }));
const pack = (over: Partial<ContextPack> = {}): ContextPack => ({
  prompts: [],
  plan: [{ id: "p1", why: "add the status column" }],
  priorMessages: [
    { id: "m1", text: "The orders table needs a status column,\nso the API must return it." },
    { id: "m2", text: "Now the DTO." },
  ],
  readPaths: [],
  edits: [],
  commandsAfter: [],
  ...over,
});
const intent = (over: Partial<Intent>): Intent => ({
  edit_ids: ["e1"],
  why: "the table needs status and the API didn't return it",
  cite_msg_id: "m1",
  quote: "needs a status column, so the API",
  serves: null,
  ...over,
});
const ground = (intents: Intent[], p = pack()) => groundIntents({ intents }, p, episode, times);

describe("grounding", () => {
  test("keeps a quote from a message before the edit, line breaks reflowed", () => {
    const { intents, rejected } = ground([intent({})]);
    expect(rejected).toEqual([]);
    expect(intents).toEqual([
      {
        id: "sess0001:ep-1-1",
        editIds: ["e1"],
        why: "the table needs status and the API didn't return it",
        serves: "ticket",
        source_msg: {
          session: "sess0001-aaaa",
          msg_id: "m1",
          quote: "needs a status column, so the API",
        },
      },
    ]);
  });

  test("rejects a fabricated quote, even with a valid plan step", () => {
    const { intents, rejected } = ground([
      intent({ quote: "orders need a status", serves: { kind: "plan_step", ref: "p1" } }),
      intent({ edit_ids: ["e2"], cite_msg_id: "m9", quote: "Now the DTO." }),
      intent({ edit_ids: ["e2"], quote: null }),
    ]);
    expect(intents).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      "quote is not in the cited message",
      "quote is not in the cited message",
      "quote is not in the cited message",
    ]);
  });

  test("rejects a quote from a message after the edit", () => {
    const { intents, rejected } = ground([intent({ cite_msg_id: "m2", quote: "the DTO" })]);
    expect(intents).toEqual([]);
    expect(rejected[0]!.reason).toBe("cited message comes after the edits");
  });

  test("keeps only the edits made after the cited message", () => {
    const { intents } = ground([
      intent({ edit_ids: ["e1", "e2"], cite_msg_id: "m2", quote: "the DTO" }),
    ]);
    expect(intents.map((i) => i.editIds)).toEqual([["e2"]]);
  });

  test("a plan step or the request can ground an intent without a quote", () => {
    const noCite = { cite_msg_id: null, quote: null };
    expect(
      ground([intent({ ...noCite, serves: { kind: "plan_step", ref: "p1" } })]).intents[0],
    ).toMatchObject({ serves: "p1", source_msg: null });
    expect(
      ground([intent({ ...noCite, serves: { kind: "ticket", ref: "ticket" } })]).rejected[0],
    ).toMatchObject({ reason: "no message, plan step or request grounds it" });
    expect(
      ground(
        [intent({ ...noCite, serves: { kind: "ticket", ref: "ticket" } })],
        pack({ prompts: ["fix it"] }),
      ).intents,
    ).toHaveLength(1);
    // An unknown plan step grounds nothing.
    expect(
      ground([intent({ ...noCite, serves: { kind: "plan_step", ref: "p7" } })]).intents,
    ).toEqual([]);
  });

  test("dead-end edits need no reason", () => {
    const p = pack({
      edits: [{ id: "e2", path: "a.ts", deadEnd: true, unifiedDiff: "" }],
    });
    const { intents, rejected } = ground(
      [
        intent({ edit_ids: ["e2"], cite_msg_id: "m2", quote: "the DTO" }),
        intent({ edit_ids: ["e1", "e2"] }),
      ],
      p,
    );
    expect(rejected.map((r) => r.reason)).toEqual(["only dead-end edits"]);
    expect(intents.map((i) => i.editIds)).toEqual([["e1"]]);
  });

  test("each edit goes to the first intent that claims it; foreign edits are ignored", () => {
    const { intents, rejected } = ground([
      intent({ edit_ids: ["e1", "x9"] }),
      intent({ edit_ids: ["e1"], why: "again" }),
    ]);
    expect(intents.map((i) => i.editIds)).toEqual([["e1"]]);
    expect(rejected[0]!.reason).toBe("no edit of this episode left to explain");
  });
});

let n = 0;
function hunk(path: string, added: string[]): Hunk {
  return {
    id: `h${++n}`,
    path,
    status: "modified",
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: added.length,
    lines: added.map((text) => ({ kind: "+" as const, text })),
    contentHash: `c${n}`,
  };
}

describe("links", () => {
  const files: Record<string, string> = {
    "src/api.ts": 'import { Order } from "./order.js";\n',
    "src/order.ts": "export type Order = {};\n",
    "src/other.ts": "",
  };
  const related = importRelation(Object.keys(files), (p) => files[p] ?? null);
  const nodes = [
    { id: "a", serves: "ticket", files: ["src/order.ts"] },
    { id: "b", serves: "ticket", files: ["src/api.ts"] },
    { id: "c", serves: "p1", files: ["src/other.ts"] },
  ];
  const plan = new Map([["p1", ["src/other.ts"]]]);

  test("an import or a shared file makes a link high; otherwise it's kept but low", () => {
    const links = checkLinks(
      nodes,
      [
        { intent_id: "b", serves: "a" },
        { intent_id: "c", serves: "a" },
      ],
      plan,
      related,
    );
    expect(Object.fromEntries(links)).toEqual({
      a: { serves: "ticket", confidence: "high" },
      b: { serves: "a", confidence: "high" },
      c: { serves: "a", confidence: "low" },
    });
  });

  test("unknown ids, self links and cycles fall back to pass 1", () => {
    const links = checkLinks(
      nodes,
      [
        { intent_id: "a", serves: "b" },
        { intent_id: "b", serves: "a" },
        { intent_id: "c", serves: "c" },
        { intent_id: "zz", serves: "a" },
      ],
      plan,
      related,
    );
    expect([...links.values()].map((l) => l.serves)).toEqual(["b", "ticket", "p1"]);
    expect(links.get("c")!.confidence).toBe("high");
  });
});

describe("concepts", () => {
  test("defining hunk before its users; model order otherwise", () => {
    const use = hunk("src/api.ts", ["  return toDto(order);"]);
    const other = hunk("src/log.ts", ["  log(1);"]);
    const def = hunk("src/dto.ts", ["export function toDto(o) {"]);
    expect(orderByDataFlow([use, other, def]).map((h) => h.path)).toEqual([
      "src/log.ts",
      "src/dto.ts",
      "src/api.ts",
    ]);
  });

  test("every hunk placed at most once; roles in order; test hunks listed", () => {
    const [a, b, t, extra] = [
      hunk("src/a.ts", ["x"]),
      hunk("src/b.ts", ["y"]),
      hunk("src/a.test.ts", ["z"]),
      hunk("src/c.ts", ["w"]),
    ];
    const { concepts, placed } = buildConcepts(
      {
        concepts: [
          {
            title: "Return status!",
            path: [
              { role: "proof", hunks: [t.id], hands_off: "tested" },
              { role: "blocker", hunks: [], hands_off: "the DTO had no field" },
              { role: "change", hunks: [a.id, "nope", b.id], hands_off: "returns status" },
            ],
          },
          {
            title: "Return status!",
            path: [{ role: "change", hunks: [a.id], hands_off: "dup" }],
          },
        ],
      },
      [a, b, t, extra],
    );
    expect(concepts).toEqual([
      {
        id: "return-status",
        title: "Return status!",
        entry: a.id,
        path: [
          { step: 1, role: "blocker", hunks: [], hands_off: "the DTO had no field" },
          { step: 2, role: "change", hunks: [a.id, b.id], hands_off: "returns status" },
          { step: 3, role: "proof", hunks: [t.id], tests: [t.id], hands_off: "tested" },
        ],
      },
    ]);
    expect([...placed].sort()).toEqual([a.id, b.id, t.id].sort());
  });
});

describe("briefing", () => {
  test("five items per list, five lines per field; not_run only when something didn't run", () => {
    const b = finishBriefing(
      {
        requirement: "1\n2\n3\n4\n5\n6",
        approach: "one way",
        assumptions: ["a", "b", "c", "d", "e", "f"],
        not_run: ["the UI"],
      },
      false,
    );
    expect(b).toEqual({
      requirement: "1\n2\n3\n4\n5",
      approach: "one way",
      assumptions: ["a", "b", "c", "d", "e"],
      not_run: [],
    });
  });
});

// Answers each pass from its input, as a well-behaved model would: cite the
// first statement before the edits, else the plan step, else the request.
function scripted(fail: string[] = []): LlmProvider & { calls: string[] } {
  const calls: string[] = [];
  const pass = new Map([
    [INTENTS_SYSTEM, "intents"],
    [LINKS_SYSTEM, "links"],
    [CONCEPTS_SYSTEM, "concepts"],
    [BRIEFING_SYSTEM, "briefing"],
    [DRIFT_SYSTEM, "drift"],
  ]);
  return {
    id: "fake",
    calls,
    healthcheck: async () => ({ ok: true, detail: "" }),
    async complete(req) {
      const name = pass.get(req.system)!;
      calls.push(name);
      if (fail.includes(name)) throw new LlmError(`${name} failed`);
      const input = JSON.parse(req.prompt);
      const data = answer(name, input);
      return { text: "", data: req.schema!.parse(data), model: "fake-model" };
    },
  };
}

// The fields each pass reads, all in one loose shape.
type PassInput = ContextPack & {
  intents: { id: string; intent_id: string; files: { path: string }[] }[];
  hunks: { id: string }[];
  notRun: string[];
};

function answer(pass: string, input: PassInput): unknown {
  switch (pass) {
    case "intents": {
      const p = input;
      const msg = p.priorMessages[0];
      const step = p.edits.find((e) => e.planStep)?.planStep;
      return {
        intents: [
          {
            edit_ids: p.edits.map((e) => e.id),
            why: msg ? `Because: ${msg.text.slice(0, 40)}` : "Carries out the plan step.",
            cite_msg_id: msg?.id ?? null,
            quote: msg ? msg.text.slice(0, 20) : null,
            serves: step ? { kind: "plan_step", ref: step } : { kind: "ticket", ref: "ticket" },
          },
        ],
      };
    }
    case "links":
      return { links: input.intents.map((i) => ({ intent_id: i.id, serves: "ticket" })) };
    case "concepts":
      return {
        concepts: [
          {
            title: "Fix the discount",
            path: [
              {
                role: "change",
                hunks: input.hunks.map((h) => h.id),
                hands_off: "discount applied once",
              },
            ],
          },
        ],
      };
    case "briefing":
      return {
        requirement: "Stop the double discount.",
        approach: "Apply it once in the order.",
        assumptions: ["prices are in cents"],
        not_run: input.notRun.length ? ["cart.js after the script touched it"] : [],
      };
    case "drift":
      return {
        results: input.intents.map((i) => ({
          intent_id: i.intent_id,
          drift: true,
          files: [i.files[0]!.path],
          reason: "goes beyond",
        })),
      };
  }
  throw new Error(`unknown pass ${pass}`);
}

describe("end to end on a recorded session", () => {
  let run: ReplayResult;
  beforeEach(() => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    run = replayFixture("subagent-tasks");
  });
  afterEach(() => {
    run.cleanup();
    vi.unstubAllEnvs();
  });

  async function enrich(provider: LlmProvider) {
    const root = run.repo.dir;
    const inputs = loadBriefingInputs(root, {});
    const blob = (h: string) => (hasBlob(root, h) ? getBlob(root, h) : null);
    const episodes = splitEpisodes(inputs.events);
    const packs = buildContextPacks(inputs.events, episodes, {
      blob,
      deadEnds: inputs.mapping.deadEnds.map((d) => d.editId),
    });
    const contents = targetContents(root, inputs.resolved.spec);
    const result = await enrichModel(
      {
        ...inputs,
        deterministic: enrichDeterministic(inputs),
        episodes,
        packs,
        read: (p) => contents.final(p)?.toString("utf8") ?? null,
      },
      provider,
    );
    const { rejected: _, ...parts } = result;
    const annotations = parseAnnotations({
      v: 1,
      briefing_id: inputs.resolved.briefingId,
      target: inputs.resolved.target,
      sessions: inputs.sessionIds,
      generated_at: "2026-10-23T12:00:00.000Z",
      status: "complete",
      ...parts,
    });
    return { inputs, result, annotations };
  }

  test("produces a valid annotations.json", async () => {
    const provider = scripted();
    const { inputs, result, annotations } = await enrich(provider);

    expect(result.errors).toEqual([]);
    expect(annotations.enrich).toEqual({
      provider: "fake",
      model: "fake-model",
      prompt_version: PROMPT_VERSION,
    });
    expect(provider.calls.filter((c) => c === "intents")).toHaveLength(
      splitEpisodes(inputs.events).length,
    );
    // Every hunk the agent wrote got a model why; the rest stay recorded.
    const llm = annotations.hunks.filter((h) => h.source.why === "llm");
    expect(llm.length).toBeGreaterThan(0);
    for (const h of llm) {
      expect(h.why).toBeTruthy();
      expect(annotations.intents.some((i) => i.id === h.intent_id)).toBe(true);
    }
    // Every hunk is on a path or off it, never both, never twice.
    const onPath = annotations.concepts.flatMap((c) => c.path.flatMap((s) => s.hunks));
    expect(new Set(onPath).size).toBe(onPath.length);
    expect([...onPath, ...annotations.off_path].sort()).toEqual(
      annotations.hunks.map((h) => h.id).sort(),
    );
    const b = annotations.briefing!;
    expect(b.requirement).toBe("Stop the double discount.");
    expect(annotations.hunks.some((h) => h.drift)).toBe(true);
  });

  test("a failed pass keeps the deterministic output and records the error", async () => {
    const { result, annotations } = await enrich(scripted(["concepts", "briefing"]));
    expect(result.errors.map((e) => e.stage)).toEqual(["concepts", "briefing"]);
    expect(annotations.concepts).toEqual([]);
    expect(annotations.briefing).toBeNull();
    expect(annotations.hunks.some((h) => h.source.why === "llm")).toBe(true);
  });

  test("with pass 1 failing, hunks keep their recorded intents", async () => {
    const { result, annotations, inputs } = await enrich(scripted(["intents"]));
    expect(result.errors.every((e) => e.stage.startsWith("intents:"))).toBe(true);
    const det = enrichDeterministic(inputs);
    expect(annotations.hunks.map((h) => h.intent_id)).toEqual(det.hunks.map((h) => h.intent_id));
    expect(annotations.hunks.every((h) => h.why === null)).toBe(true);
  });
});

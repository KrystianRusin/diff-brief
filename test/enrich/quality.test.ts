import { describe, expect, test } from "vitest";
import type { Hunk } from "../../src/diff/index.js";
import type { GroundedIntent } from "../../src/enrich/model/intents.js";
import { QUALITY_SYSTEM } from "../../src/enrich/model/prompts.js";
import {
  cheapChecks,
  diffSide,
  qualityPass,
  qualityStats,
  type Ask,
  type Flag,
  type QualityReply,
} from "../../src/enrich/model/quality.js";

function hunk(path: string, added: string[], removed: string[] = []): Hunk {
  return {
    id: `${path}#1`,
    path,
    status: "modified",
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    lines: [
      ...removed.map((text) => ({ kind: "-" as const, text })),
      ...added.map((text) => ({ kind: "+" as const, text })),
    ],
    contentHash: "c",
  };
}

// The spec's example: the order service starts returning status.
const service = hunk(
  "src/order-service.ts",
  ["  return { ...order, status: row.status };"],
  ["  return { ...order };"],
);
const retry = hunk("src/http/client.ts", [
  "const MAX_RETRIES = 3;",
  "  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {",
  "    try { return await fetchJson(url); } catch (err) { lastError = err; }",
  "  }",
]);
const cache = hunk("src/cache.ts", ["  invalidate(userId);"]);
const dto = hunk("src/dto/order-dto.ts", ["  status: OrderStatus;"]);
const big = hunk(
  "src/report.ts",
  Array.from({ length: 12 }, (_, i) => `  line${i}();`),
);

const long =
  "The nightly export job reads every order row and writes a CSV for finance, and finance " +
  "reconciles that file against the payment provider each morning, so when status was " +
  "missing the reconciliation flagged every refunded order as unpaid and someone had to " +
  "fix it by hand.";

const cases: [string, Hunk, Flag[]][] = [
  // The spec's pair.
  ["updates the service to return status", service, ["restates_diff"]],
  ["the table needs status and the API didn't return it", service, []],
  // Restating the diff.
  ["Return status from the order service", service, ["restates_diff"]],
  ["Adds MAX_RETRIES and retries fetchJson", retry, ["restates_diff"]],
  ["Invalidate the user cache", cache, ["restates_diff"]],
  ["adds a status field of type OrderStatus to the order DTO", dto, ["restates_diff"]],
  // Reasons.
  ["the payments API drops one call in fifty under load", retry, []],
  ["stale profiles showed after a rename until the next login", cache, []],
  ["the mobile client renders the order badge from it", dto, []],
  ["finance needs refunds split out from cancellations", service, []],
  // Preamble and filler.
  ["This change makes refunds visible to finance", service, ["preamble"]],
  ["This PR fixes stale profiles after a rename", cache, ["preamble"]],
  ["Updated so the badge renders on mobile", dto, ["preamble"]],
  ["Modified to survive flaky payment calls", retry, ["preamble"]],
  ["Changes needed so finance can reconcile refunds", service, ["preamble"]],
  ["this commit keeps stale profiles from showing", cache, ["preamble"]],
  // Hedging.
  ["I think the payments API drops calls under load", retry, ["hedging"]],
  ["stale profiles might show after a rename", cache, ["hedging"]],
  ["the mobile badge possibly needs it", dto, ["hedging"]],
  ["it seems finance reconciles against this", service, ["hedging"]],
  ["probably needed for the mobile badge", dto, ["hedging"]],
  // Length: only a flag when the hunk is small.
  [long, dto, ["long"]],
  [long, big, []],
  // Several at once.
  [
    "This change might return status from the order service",
    service,
    ["restates_diff", "preamble", "hedging"],
  ],
  // Words that merely contain a hedge or preamble aren't one.
  ["mighty batch jobs choke on the unchanged export", big, []],
  ["changelog readers asked for refunds split out", service, []],
];

describe("cheap checks", () => {
  test.each(cases)("%s", (why, h, flags) => {
    expect(cheapChecks(why, diffSide([h]))).toEqual(flags);
  });
});

const grounded = (
  id: string,
  why: string,
  quote: string | null = "finance needs refunds",
): GroundedIntent => ({
  id,
  editIds: [`${id}-e`],
  why,
  serves: "ticket",
  source_msg: quote ? { session: "s", msg_id: "m1", quote } : null,
});

// Answers from a table keyed by intent id; records what it was asked.
function judge(answers: Record<string, Omit<QualityReply["items"][number], "id">>) {
  const calls: { stage: string; ids: string[] }[] = [];
  const ask: Ask = async (stage, system, data, schema) => {
    expect(system).toBe(QUALITY_SYSTEM);
    const items = (data as { items: { id: string }[] }).items;
    calls.push({ stage, ids: items.map((i) => i.id) });
    return schema.parse({
      items: items.flatMap((i) => (answers[i.id] ? [{ id: i.id, ...answers[i.id] }] : [])),
    });
  };
  return { ask, calls };
}

describe("quality pass", () => {
  const diffOf = () => [service];

  test("rewrite that passes is kept; one that still fails, or none, drops the why", async () => {
    const intents = [
      grounded("good", "finance needs refunds split out from cancellations"),
      grounded("fixed", "updates the service to return status"),
      grounded("still-bad", "This change returns status from the service"),
      grounded("no-rewrite", "Return status from the order service"),
    ];
    const { ask, calls } = judge({
      fixed: { verdict: "restates_diff", rewrite: "finance needs refunds told apart" },
      "still-bad": { verdict: "padded", rewrite: "This change returns status" },
      "no-rewrite": { verdict: "restates_diff", rewrite: null },
    });
    const r = await qualityPass(intents, diffOf, ask);

    expect(calls.flatMap((c) => c.ids)).toEqual(
      expect.arrayContaining(["fixed", "still-bad", "no-rewrite"]),
    );
    expect(r.intents.map((g) => [g.id, g.why])).toEqual([
      ["good", "finance needs refunds split out from cancellations"],
      ["fixed", "finance needs refunds told apart"],
    ]);
    expect(r.dropped.map((g) => g.id)).toEqual(["still-bad", "no-rewrite"]);
    expect(r.outcomes.map((o) => o.outcome)).toEqual(["kept", "rewritten", "dropped", "dropped"]);
    expect(qualityStats(r.outcomes)).toEqual({ suspects: 3, rewritten: 1, dropped: 2 });
  });

  test("ok from the judge keeps a flagged why; no answer keeps it too", async () => {
    const intents = [
      grounded("a", "Return status from the order service"),
      grounded("b", "updates the service to return status"),
    ];
    const r = await qualityPass(
      intents,
      diffOf,
      judge({ a: { verdict: "ok", rewrite: null } }).ask,
    );
    expect(r.intents.map((g) => g.id)).toEqual(["a", "b"]);
    expect(r.dropped).toEqual([]);
  });

  test("a failed judge call drops nothing", async () => {
    const intents = [grounded("a", "Return status from the order service")];
    const r = await qualityPass(intents, diffOf, async () => undefined);
    expect(r.intents).toEqual(intents);
    expect(qualityStats(r.outcomes)).toEqual({ suspects: 1, rewritten: 0, dropped: 0 });
  });

  test("suspects plus about one in ten of the rest, twenty per call", async () => {
    const clean = Array.from({ length: 200 }, (_, i) =>
      grounded(`ok${i}`, "finance needs refunds split out from cancellations"),
    );
    const suspects = Array.from({ length: 30 }, (_, i) =>
      grounded(`bad${i}`, "Return status from the order service"),
    );
    const { ask, calls } = judge({});
    await qualityPass([...clean, ...suspects], diffOf, ask);
    const asked = calls.flatMap((c) => c.ids);
    const sampled = asked.filter((id) => id.startsWith("ok")).length;
    expect(asked.filter((id) => id.startsWith("bad"))).toHaveLength(30);
    expect(sampled).toBeGreaterThan(5);
    expect(sampled).toBeLessThan(40);
    expect(calls.every((c) => c.ids.length <= 20)).toBe(true);
    expect(calls.map((c) => c.stage)).toEqual(calls.map((_, i) => `quality:${i + 1}`));
    // Same intents, same sample.
    const again = judge({});
    await qualityPass([...clean, ...suspects], diffOf, again.ask);
    expect(again.calls.flatMap((c) => c.ids)).toEqual(asked);
  });
});

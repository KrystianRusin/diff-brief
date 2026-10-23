import { createHash } from "node:crypto";
import { z, type ZodType } from "zod";
import type { Hunk } from "../../diff/index.js";
import type { GroundedIntent } from "./intents.js";
import { QUALITY_SYSTEM } from "./prompts.js";

// Quality pass (DB-14): a why that restates the diff, pads or hedges is worse
// than none. Cheap checks in code flag suspects; a model judge looks at them
// plus a sample of the rest and may offer one tighter rewrite. A rewrite has
// to pass the cheap checks itself, or the why is dropped and the reviewer sees
// the agent's own words instead.

export type Flag = "restates_diff" | "preamble" | "hedging" | "long";

export const QualityReply = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["ok", "restates_diff", "padded", "ungrounded"]),
      rewrite: z.string().nullable(),
    }),
  ),
});
export type QualityReply = z.infer<typeof QualityReply>;

export type QualityOutcome = {
  intent: string;
  why: string;
  flags: Flag[];
  verdict?: QualityReply["items"][number]["verdict"];
  outcome: "kept" | "rewritten" | "dropped";
  rewrite?: string;
};

export type QualityStats = { suspects: number; rewritten: number; dropped: number };

export type Ask = <T>(
  stage: string,
  system: string,
  data: unknown,
  schema: ZodType<T>,
) => Promise<T | undefined>;

const RESTATE_SHARE = 0.6;
const LONG_WORDS = 40;
const SHORT_HUNK = 10;
const BATCH = 20;
const EXCERPT = 20;

const PREAMBLE = /^\s*(this (change|pr|commit|patch|diff)\b|updated\b|modified\b|change[sd]\b)/i;
const HEDGES = /\b(i think|might|possibly|it seems|seems to|perhaps|probably|maybe)\b/i;

// Words that say nothing about the reason: grammar, and the verbs every diff
// description leads with.
const STOPWORDS = new Set(
  (
    "a an the and or but if then else so to of in on at by for with from into onto as " +
    "is are was were be been being it its this that these those there here which who what " +
    "when where why how not no do does did didnt doesnt dont isnt wasnt cant wont can will " +
    "would should could must may might has have had now also just only than too very more " +
    "less all any each some we our you your they their them he she me my " +
    "add adds added adding update updates updated updating change changes changed changing " +
    "modify modifies modified use uses used using make makes made set sets new instead because"
  ).split(" "),
);

// The changed lines and paths of the hunks an intent covers.
export type DiffSide = { lines: string[]; paths: string[] };

export function diffSide(hunks: Hunk[]): DiffSide {
  return {
    lines: hunks.flatMap((h) => h.lines.filter((l) => l.kind !== " ").map((l) => l.text)),
    paths: [...new Set(hunks.map((h) => h.path))],
  };
}

export function cheapChecks(why: string, diff: DiffSide): Flag[] {
  const flags: Flag[] = [];
  const said = tokens(why);
  if (said.length >= 2) {
    const seen = new Set(tokens([...diff.lines, ...diff.paths].join("\n")));
    if (said.filter((t) => seen.has(t)).length / said.length > RESTATE_SHARE)
      flags.push("restates_diff");
  }
  if (PREAMBLE.test(why)) flags.push("preamble");
  if (HEDGES.test(why)) flags.push("hedging");
  if (why.split(/\s+/).filter(Boolean).length > LONG_WORDS && diff.lines.length < SHORT_HUNK)
    flags.push("long");
  return flags;
}

// Lowercased words, identifiers split at camelCase and underscores, plural
// and tense endings stripped, so "returns" meets `getReturn`.
function tokens(text: string): string[] {
  return text
    .replace(/['’]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem);
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  for (const end of ["ing", "ed", "s"]) {
    if (w.length - end.length >= 3 && w.endsWith(end) && !w.endsWith("ss"))
      return w.slice(0, -end.length);
  }
  return w;
}

// About one in ten, stable per intent so re-runs judge the same ones.
function sampled(id: string): boolean {
  return createHash("sha256").update(id).digest()[0]! % 10 === 0;
}

export async function qualityPass(
  intents: GroundedIntent[],
  diffOf: (id: string) => Hunk[],
  ask: Ask,
): Promise<{ intents: GroundedIntent[]; dropped: GroundedIntent[]; outcomes: QualityOutcome[] }> {
  const items = intents.map((g) => {
    const hunks = diffOf(g.id);
    const diff = diffSide(hunks);
    return { g, diff, hunks, flags: cheapChecks(g.why, diff) };
  });
  const judged = items.filter((i) => i.flags.length > 0 || sampled(i.g.id));

  const batches: (typeof judged)[] = [];
  for (let i = 0; i < judged.length; i += BATCH) batches.push(judged.slice(i, i + BATCH));
  const replies = await Promise.all(
    batches.map((batch, n) =>
      ask(
        `quality:${n + 1}`,
        QUALITY_SYSTEM,
        {
          items: batch.map((i) => ({
            id: i.g.id,
            why: i.g.why,
            hunk_excerpt: excerpt(i.hunks),
            cited_quote: i.g.source_msg?.quote ?? null,
            flags: i.flags,
          })),
        },
        QualityReply,
      ),
    ),
  );
  const verdicts = new Map(replies.flatMap((r) => r?.items ?? []).map((v) => [v.id, v]));

  const kept: GroundedIntent[] = [];
  const dropped: GroundedIntent[] = [];
  const outcomes = items.map(({ g, diff, flags }): QualityOutcome => {
    const base = { intent: g.id, why: g.why, flags };
    // Not judged, or the judge didn't answer: the why stands.
    const v = verdicts.get(g.id);
    if (!v || v.verdict === "ok") {
      kept.push(g);
      return { ...base, ...(v ? { verdict: v.verdict } : {}), outcome: "kept" };
    }
    const rewrite = v.rewrite?.trim();
    if (rewrite && cheapChecks(rewrite, diff).length === 0) {
      kept.push({ ...g, why: rewrite });
      return { ...base, verdict: v.verdict, outcome: "rewritten", rewrite };
    }
    dropped.push(g);
    return {
      ...base,
      verdict: v.verdict,
      outcome: "dropped",
      ...(rewrite ? { rewrite } : {}),
    };
  });
  return { intents: kept, dropped, outcomes };
}

export function qualityStats(outcomes: QualityOutcome[]): QualityStats {
  return {
    suspects: outcomes.filter((o) => o.flags.length > 0).length,
    rewritten: outcomes.filter((o) => o.outcome === "rewritten").length,
    dropped: outcomes.filter((o) => o.outcome === "dropped").length,
  };
}

// The first changed lines across an intent's hunks, each under its path.
function excerpt(hunks: Hunk[]): string[] {
  const out: string[] = [];
  for (const h of hunks) {
    if (out.length >= EXCERPT) break;
    out.push(`--- ${h.path}`);
    for (const l of h.lines) {
      if (l.kind === " ") continue;
      if (out.length >= EXCERPT) break;
      out.push(l.kind + l.text);
    }
  }
  return out;
}

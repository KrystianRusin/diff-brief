import { z } from "zod";
import type { Hunk } from "../../diff/index.js";
import { StepRole, type Annotations } from "../../schema/annotations.js";
import { isTestFile } from "../deterministic/test-rules.js";

// Pass 3 (DB-13): concepts with an ordered review path. The model groups and
// labels; code decides what's valid: each hunk lands in at most one step,
// steps follow the role order, and hunks within a step are put in data-flow
// order (definition before use), the model's order breaking ties.

export const ConceptsReply = z.object({
  concepts: z.array(
    z.object({
      title: z.string(),
      path: z.array(
        z.object({
          role: StepRole,
          layer: z.string().optional(),
          hunks: z.array(z.string()),
          hands_off: z.string(),
        }),
      ),
    }),
  ),
});
export type ConceptsReply = z.infer<typeof ConceptsReply>;

type Concept = Annotations["concepts"][number];
type PathStep = Concept["path"][number];

const ROLE_ORDER = StepRole.options;

// eligible: hunks that may go on a path; anything else the model names is
// ignored. Returns the concepts and the ids they placed.
export function buildConcepts(
  reply: ConceptsReply,
  eligible: Hunk[],
): { concepts: Concept[]; placed: Set<string> } {
  const byId = new Map(eligible.map((h) => [h.id, h]));
  const placed = new Set<string>();
  const ids = new Set<string>();
  const concepts: Concept[] = [];

  for (const c of reply.concepts) {
    const steps = c.path
      .map((s, i) => ({ s, i }))
      .sort((a, b) => ROLE_ORDER.indexOf(a.s.role) - ROLE_ORDER.indexOf(b.s.role) || a.i - b.i)
      .flatMap(({ s }): Omit<PathStep, "step">[] => {
        const mine = s.hunks.filter((id) => byId.has(id) && !placed.has(id));
        // A step that only had duplicates or unknown ids has nothing left to
        // show; one proposed without hunks explains (a blocker) and stays.
        if (s.hunks.length > 0 && mine.length === 0) return [];
        for (const id of mine) placed.add(id);
        const hunks = orderByDataFlow(mine.map((id) => byId.get(id)!)).map((h) => h.id);
        const tests = hunks.filter((id) => isTestFile(byId.get(id)!.path));
        return [
          {
            role: s.role,
            ...(s.layer ? { layer: s.layer } : {}),
            hunks,
            ...(tests.length ? { tests } : {}),
            hands_off: s.hands_off.trim(),
          },
        ];
      });
    const entry = steps.find((s) => s.hunks.length > 0)?.hunks[0];
    if (!entry) continue;
    concepts.push({
      id: uniqueId(slug(c.title), ids),
      title: c.title.trim(),
      entry,
      path: steps.map((s, i) => ({ step: i + 1, ...s })),
    });
  }
  return { concepts, placed };
}

// Declarations across common languages: the name after the keyword, or an
// assigned function (`const f = (`, `f: function`).
const DECL = [
  /\b(?:function\*?|class|interface|type|enum|struct|trait|def|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/g,
];
const WORD = /[A-Za-z_$][\w$]*/g;
const MIN_SYMBOL = 3;

// A hunk that defines a symbol comes before the hunks that use it. Stable:
// hunks with no such relation keep their given order, and so does a cycle.
export function orderByDataFlow(hunks: Hunk[]): Hunk[] {
  if (hunks.length < 2) return hunks;
  const added = hunks.map((h) =>
    h.lines
      .filter((l) => l.kind === "+")
      .map((l) => l.text)
      .join("\n"),
  );
  const defs = added.map(
    (text) => new Set(DECL.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!)).filter(long)),
  );
  const words = added.map((text) => new Set((text.match(WORD) ?? []).filter(long)));

  // before[u] = hunks that define something u uses.
  const before = hunks.map((_, u) =>
    hunks.flatMap((_, d) => (d !== u && [...defs[d]!].some((s) => words[u]!.has(s)) ? [d] : [])),
  );
  const out: number[] = [];
  const done = new Set<number>();
  while (out.length < hunks.length) {
    const left = hunks.map((_, i) => i).filter((i) => !done.has(i));
    const next = left.find((i) => before[i]!.every((d) => done.has(d))) ?? left[0]!;
    out.push(next);
    done.add(next);
  }
  return out.map((i) => hunks[i]!);
}

function long(s: string): boolean {
  return s.length >= MIN_SYMBOL;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "concept"
  );
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

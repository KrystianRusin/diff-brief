import { z } from "zod";
import type { Hunk } from "../../diff/index.js";

// Drift (DB-13): does an intent's change go beyond what its why describes?
// Code picks the intents worth asking about by spread (several files) or
// size; the model judges them in one call, naming the files that go beyond.

export const DriftReply = z.object({
  results: z.array(
    z.object({
      intent_id: z.string(),
      drift: z.boolean(),
      files: z.array(z.string()),
      reason: z.string(),
    }),
  ),
});
export type DriftReply = z.infer<typeof DriftReply>;

export type DriftCandidate = {
  intent_id: string;
  why: string;
  files: { path: string; changed_lines: number }[];
};

// A one-file change of this size or less reads at a glance; nothing to ask.
const MIN_LINES = 40;

export function driftCandidates(
  intents: { id: string; why: string }[],
  hunksOf: Map<string, Hunk[]>,
): DriftCandidate[] {
  return intents.flatMap((i) => {
    const byPath = new Map<string, number>();
    for (const h of hunksOf.get(i.id) ?? []) {
      const n = h.lines.filter((l) => l.kind !== " ").length;
      byPath.set(h.path, (byPath.get(h.path) ?? 0) + n);
    }
    const total = [...byPath.values()].reduce((a, b) => a + b, 0);
    if (byPath.size < 2 && total <= MIN_LINES) return [];
    return [
      {
        intent_id: i.id,
        why: i.why,
        files: [...byPath].map(([path, changed_lines]) => ({ path, changed_lines })),
      },
    ];
  });
}

// Hunk ids to flag: those of a drifting intent in the files the model named,
// or all of them when it named none it was given.
export function driftedHunks(reply: DriftReply, hunksOf: Map<string, Hunk[]>): Set<string> {
  const out = new Set<string>();
  for (const r of reply.results) {
    if (!r.drift) continue;
    const hunks = hunksOf.get(r.intent_id) ?? [];
    const named = hunks.filter((h) => r.files.includes(h.path));
    for (const h of named.length ? named : hunks) out.add(h.id);
  }
  return out;
}

import { z } from "zod";
import { GitSha, Timestamp, Version } from "./common.js";
import { migrateAnnotations } from "./migrate.js";
import { assertReadableVersion } from "./version.js";

// .diffbrief/briefings/<briefing_id>/annotations.json, one per diff target
// (DB-09). Written by enrich, read by every renderer.

export const DiffTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktree"), base: GitSha, head: z.literal("WORKTREE") }),
  z.object({ kind: z.literal("commit"), base: GitSha, head: GitSha }),
  z.object({ kind: z.literal("range"), base: GitSha, head: GitSha }),
]);

export const Followup = z.object({
  ask: z.string(),
  preset: z
    .enum(["explain_more", "why_not_another_way", "what_could_break", "where_used"])
    .optional(),
  answer: z.string(),
  kind: z.enum(["recorded", "reconstructed"]),
  cite_msg_ids: z.array(z.string()).optional(),
  ts: Timestamp,
});

export const Briefing = z.object({
  requirement: z.string(),
  approach: z.string(),
  skipped_alternatives: z.array(z.string()),
  assumptions: z.array(z.string()),
  not_run: z.array(z.string()),
  followups: z.array(Followup).optional(),
});

export const StepRole = z.enum(["problem", "blocker", "enabling", "change", "proof"]);

export const PathStep = z.object({
  step: z.number().int().positive(),
  role: StepRole,
  layer: z.string().optional(),
  hunks: z.array(z.string()),
  tests: z.array(z.string()).optional(),
  hands_off: z.string(),
  followups: z.array(Followup).optional(),
});

export const Concept = z.object({
  id: z.string(),
  title: z.string(),
  entry: z.string(), // hunk id to start reading at
  path: z.array(PathStep),
});

export const Warning = z.object({
  kind: z.enum(["deleted_test", "weakened_test", "unexplained", "failed_not_rerun"]),
  hunks: z.array(z.string()).optional(),
  detail: z.string(),
  source: z.enum(["rules", "log"]),
});

export const Intent = z.object({
  id: z.string(), // namespaced: <session8>:<id>
  why: z.string(),
  serves: z.string(), // intent id, plan step id, "ticket", or "unexplained"
  source_msg: z.object({ session: z.string(), msg_id: z.string(), quote: z.string() }).nullable(),
  link_confidence: z.enum(["high", "low"]).optional(),
});

export const Hunk = z.object({
  id: z.string(),
  path: z.string(),
  old_path: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  old_start: z.number().int().nonnegative(),
  old_lines: z.number().int().nonnegative(),
  new_start: z.number().int().nonnegative(),
  new_lines: z.number().int().nonnegative(),
  content_hash: z.string(),
  why: z.string().nullable(), // null until the model pass, or when dropped by quality
  intent_id: z.string().nullable(),
  intent_history: z.array(z.string()),
  serves: z.literal("unexplained").optional(),
  external_touched: z.boolean(),
  drift: z.boolean(),
  exec: z.enum(["tested", "ran", "never_executed"]),
  risk: z.array(z.string()),
  source: z.object({
    // "quote": quality pass dropped the model text and shows the agent's words instead
    why: z.enum(["llm", "quote"]).nullable(),
    exec: z.literal("log"),
    risk: z.literal("rules"),
  }),
  followups: z.array(Followup).optional(),
});

export const Annotations = z
  .object({
    v: Version,
    briefing_id: z.string(),
    target: DiffTarget,
    sessions: z.array(z.string()),
    generated_at: Timestamp,
    status: z.enum(["partial", "complete"]),
    errors: z.array(z.object({ stage: z.string(), message: z.string() })),
    enrich: z.object({
      provider: z.string(),
      model: z.string().optional(),
      prompt_version: z.string(),
      quality: z
        .object({
          suspects: z.number().int().nonnegative(),
          rewritten: z.number().int().nonnegative(),
          dropped: z.number().int().nonnegative(),
        })
        .optional(),
    }),
    briefing: Briefing.nullable(), // null while partial
    read_first: z.array(z.string()).max(3),
    concepts: z.array(Concept),
    off_path: z.array(z.string()),
    warnings: z.array(Warning),
    intents: z.array(Intent),
    hunks: z.array(Hunk),
  })
  .superRefine((a, ctx) => {
    const hunkIds = new Set(a.hunks.map((h) => h.id));
    const intentIds = new Set(a.intents.map((i) => i.id));
    const missingHunk = (id: string, path: (string | number)[]) => {
      if (!hunkIds.has(id)) ctx.addIssue({ code: "custom", message: `unknown hunk ${id}`, path });
    };

    if (hunkIds.size !== a.hunks.length) {
      ctx.addIssue({ code: "custom", message: "duplicate hunk ids", path: ["hunks"] });
    }
    a.read_first.forEach((id, i) => missingHunk(id, ["read_first", i]));
    a.off_path.forEach((id, i) => missingHunk(id, ["off_path", i]));
    a.concepts.forEach((c, ci) => {
      missingHunk(c.entry, ["concepts", ci, "entry"]);
      c.path.forEach((s, si) =>
        s.hunks.forEach((id, hi) => missingHunk(id, ["concepts", ci, "path", si, "hunks", hi])),
      );
    });
    a.warnings.forEach((w, wi) =>
      w.hunks?.forEach((id, hi) => missingHunk(id, ["warnings", wi, "hunks", hi])),
    );
    a.hunks.forEach((h, hi) => {
      if (h.intent_id !== null && !intentIds.has(h.intent_id)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown intent ${h.intent_id}`,
          path: ["hunks", hi, "intent_id"],
        });
      }
    });
  });

export type Annotations = z.infer<typeof Annotations>;
export type Hunk = z.infer<typeof Hunk>;
export type DiffTarget = z.infer<typeof DiffTarget>;

export function parseAnnotations(raw: unknown): Annotations {
  assertReadableVersion(raw, "annotations.json");
  return Annotations.parse(migrateAnnotations(raw));
}

import { z } from "zod";
import type { Annotations } from "../../schema/annotations.js";
import type { ContextPack } from "../context-pack.js";
import type { Episode } from "../episodes.js";

// Pass 1 (DB-13): one call per episode proposes why its edits were made. The
// model's word isn't taken for it: groundIntents() keeps an intent only when
// its reason traces to something written before the edit.

export const IntentsReply = z.object({
  intents: z.array(
    z.object({
      edit_ids: z.array(z.string()),
      why: z.string(),
      cite_msg_id: z.string().nullable(),
      quote: z.string().nullable(),
      serves: z.object({ kind: z.enum(["ticket", "plan_step"]), ref: z.string() }).nullable(),
    }),
  ),
});
export type IntentsReply = z.infer<typeof IntentsReply>;

export type GroundedIntent = {
  id: string;
  editIds: string[];
  why: string;
  serves: string; // "ticket" or a plan step id
  source_msg: Annotations["intents"][number]["source_msg"];
};

export type Rejection = { episode: string; why: string; reason: string };

// Event id (edit, message, plan step) → time.
export type Times = Map<string, number>;

export function groundIntents(
  reply: IntentsReply,
  pack: ContextPack,
  episode: Episode,
  times: Times,
): { intents: GroundedIntent[]; rejected: Rejection[] } {
  const own = new Set(episode.edit_ids);
  // Only what survives into the diff needs a reason.
  const dead = new Set(pack.edits.filter((e) => e.deadEnd).map((e) => e.id));
  const claimed = new Set<string>();
  const messages = new Map(pack.priorMessages.map((m) => [m.id, m.text]));
  const plan = new Set(pack.plan.map((p) => p.id));
  const hasRequest = !!pack.ticket || pack.prompts.length > 0;
  const at = (id: string) => times.get(id) ?? NaN;

  const intents: GroundedIntent[] = [];
  const rejected: Rejection[] = [];
  const reject = (why: string, reason: string) =>
    rejected.push({ episode: episode.id, why, reason });

  for (const r of reply.intents) {
    const mine = [...new Set(r.edit_ids)].filter((id) => own.has(id) && !claimed.has(id));
    let edits = mine.filter((id) => !dead.has(id));
    if (edits.length === 0) {
      reject(
        r.why,
        mine.length ? "only dead-end edits" : "no edit of this episode left to explain",
      );
      continue;
    }
    const step = r.serves?.kind === "plan_step" && plan.has(r.serves.ref) ? r.serves.ref : null;

    let source: GroundedIntent["source_msg"] = null;
    if (r.cite_msg_id !== null || r.quote !== null) {
      // A citation that doesn't hold up means the reason may be made up too,
      // so the intent goes, whatever else it claims.
      const text = r.cite_msg_id !== null ? messages.get(r.cite_msg_id) : undefined;
      if (text === undefined || !r.quote || !contains(text, r.quote)) {
        reject(r.why, "quote is not in the cited message");
        continue;
      }
      const said = at(r.cite_msg_id!);
      edits = edits.filter((id) => said < at(id));
      if (edits.length === 0) {
        reject(r.why, "cited message comes after the edits");
        continue;
      }
      source = { session: episode.session_id, msg_id: r.cite_msg_id!, quote: r.quote };
    } else if (step) {
      const planned = at(step);
      edits = edits.filter((id) => planned < at(id));
      if (edits.length === 0) {
        reject(r.why, "plan step comes after the edits");
        continue;
      }
    } else if (!(r.serves?.kind === "ticket" && hasRequest)) {
      reject(r.why, "no message, plan step or request grounds it");
      continue;
    }

    for (const id of edits) claimed.add(id);
    intents.push({
      id: `${episode.session_id.slice(0, 8)}:${episode.id}-${intents.length + 1}`,
      editIds: edits,
      why: r.why.trim(),
      serves: step ?? "ticket",
      source_msg: source,
    });
  }
  return { intents, rejected };
}

// Whitespace-insensitive: models reflow line breaks when they quote.
function contains(text: string, quote: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const q = flat(quote);
  return q !== "" && flat(text).includes(q);
}

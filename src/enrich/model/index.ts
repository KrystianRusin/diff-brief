import type { ZodType } from "zod";
import type { BriefingInputs } from "../../briefing/inputs.js";
import type { Hunk } from "../../diff/index.js";
import type { LlmProvider } from "../../llm/index.js";
import type { Annotations } from "../../schema/annotations.js";
import type { ContextPack } from "../context-pack.js";
import { normalize, unexplained, type DeterministicResult } from "../deterministic/index.js";
import { planSteps, type Episode } from "../episodes.js";
import { BriefingReply, finishBriefing } from "./briefing.js";
import { buildConcepts, ConceptsReply } from "./concepts.js";
import { driftCandidates, driftedHunks, DriftReply } from "./drift.js";
import { groundIntents, IntentsReply, type GroundedIntent, type Rejection } from "./intents.js";
import { checkLinks, importRelation, LinksReply, type Link } from "./links.js";
import {
  BRIEFING_SYSTEM,
  CONCEPTS_SYSTEM,
  DRIFT_SYSTEM,
  INTENTS_SYSTEM,
  LINKS_SYSTEM,
  PROMPT_VERSION,
} from "./prompts.js";

export { PROMPT_VERSION } from "./prompts.js";
export type { Rejection } from "./intents.js";

// The model passes (DB-13), on top of the deterministic result (DB-11): a
// grounded why per intent, links between intents, concepts with a review
// path, the briefing, and drift. The model writes only what the rules can't,
// and every pass is checked in code. A pass that fails leaves its fields as
// the deterministic stage had them and records an error; it never takes
// deterministic output away.

export type ModelInput = Pick<BriefingInputs, "hunks" | "events" | "mapping" | "context"> & {
  deterministic: DeterministicResult;
  // From splitEpisodes and buildContextPacks, one pack per episode.
  episodes: Episode[];
  packs: ContextPack[];
  // Final content of a changed file, for the import check on links.
  read?: (path: string) => string | null;
};

export type ModelResult = Pick<
  Annotations,
  | "hunks"
  | "intents"
  | "warnings"
  | "read_first"
  | "off_path"
  | "concepts"
  | "briefing"
  | "errors"
  | "enrich"
> & {
  // Pass 1 intents that failed grounding, for logs and tests.
  rejected: Rejection[];
};

type AnnotatedHunk = Annotations["hunks"][number];
type Intent = Annotations["intents"][number];

const HUNK_EXCERPT = 20;

export async function enrichModel(input: ModelInput, provider: LlmProvider): Promise<ModelResult> {
  const { deterministic: det, events, mapping } = input;
  const errors: Annotations["errors"] = [];
  let model: string | undefined;
  const ask = async <T>(stage: string, system: string, data: unknown, schema: ZodType<T>) => {
    try {
      const res = await provider.complete({ system, prompt: JSON.stringify(data), schema });
      model ??= res.model;
      return res.data!;
    } catch (err) {
      errors.push({ stage, message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  };

  // Pass 1, per episode, in parallel (the provider limits concurrency).
  const times = new Map<string, number>();
  for (const e of events) {
    if (e.type === "edit" || e.type === "agent_message" || e.type === "intent")
      times.set(e.id, Date.parse(e.ts));
  }
  const rejected: Rejection[] = [];
  const grounded: GroundedIntent[] = [];
  const replies = await Promise.all(
    input.packs.map((pack, i) =>
      ask(`intents:${input.episodes[i]!.id}`, INTENTS_SYSTEM, pack, IntentsReply),
    ),
  );
  replies.forEach((reply, i) => {
    if (!reply) return;
    const r = groundIntents(reply, input.packs[i]!, input.episodes[i]!, times);
    grounded.push(...r.intents);
    rejected.push(...r.rejected);
  });

  // Each hunk takes the grounded intent behind most of the edits that wrote
  // it, the latest edit breaking a tie. Hunks no grounded intent covers keep
  // their recorded intent, if they have one.
  const byEdit = new Map(grounded.flatMap((g) => g.editIds.map((id) => [id, g] as const)));
  const hunks = det.hunks.map((h): AnnotatedHunk => {
    const g = pick((mapping.byHunk[h.id]?.editIds ?? []).flatMap((id) => byEdit.get(id) ?? []));
    if (!g) return h;
    const { serves: _, ...rest } = h;
    return { ...rest, intent_id: g.id, why: g.why, source: { ...h.source, why: "llm" } };
  });

  const live = grounded.filter((g) => hunks.some((h) => h.intent_id === g.id));

  const diffHunks = new Map(input.hunks.map((h) => [h.id, h]));
  const hunksOf = new Map<string, Hunk[]>();
  for (const h of hunks) {
    if (h.intent_id)
      hunksOf.set(h.intent_id, [...(hunksOf.get(h.intent_id) ?? []), diffHunks.get(h.id)!]);
  }
  const filesOf = (id: string) => [...new Set((hunksOf.get(id) ?? []).map((h) => h.path))];

  const plan = input.context.flatMap((c) => c.plan);
  const ticket = input.context.find((c) => c.ticket)?.ticket;
  const prompts = input.context.flatMap((c) => c.prompts);

  // Pass 2: links, then pass 3 on the linked tree, then pass 4. Drift needs
  // only pass 1 and runs beside them.
  const linksAndOn = async () => {
    const nodes = live.map((g) => ({ id: g.id, serves: g.serves, files: filesOf(g.id) }));
    const reply =
      live.length > 0
        ? await ask(
            "links",
            LINKS_SYSTEM,
            {
              ...(ticket ? { ticket } : {}),
              prompts,
              plan,
              intents: nodes.map((n, i) => ({ ...n, why: live[i]!.why })),
            },
            LinksReply,
          )
        : undefined;
    const links = checkLinks(
      nodes,
      reply?.links ?? [],
      planFiles(
        events,
        plan.map((p) => p.id),
      ),
      importRelation(
        hunks.map((h) => h.path),
        input.read ?? (() => null),
      ),
    );
    const intents = annotationIntents(live, links, det.intents, hunks);
    const concepts = await conceptsPass(intents, hunks);
    const briefing = await briefingPass(concepts.concepts, hunks);
    return { intents, ...concepts, briefing };
  };

  const conceptsPass = async (intents: Intent[], hunks: AnnotatedHunk[]) => {
    // Unexplained hunks stay off the path; the warnings already list them.
    const eligible = hunks.filter((h) => h.intent_id !== null);
    const fallback = {
      concepts: [],
      off_path: hunks.filter((h) => h.serves === "unexplained").map((h) => h.id),
    };
    if (eligible.length === 0) return fallback;
    const reply = await ask(
      "concepts",
      CONCEPTS_SYSTEM,
      {
        intents: intents.map((i) => ({ id: i.id, why: i.why, serves: i.serves })),
        hunks: eligible.map((h) => excerpt(h, diffHunks.get(h.id)!)),
      },
      ConceptsReply,
    );
    if (!reply) return fallback;
    const { concepts, placed } = buildConcepts(
      reply,
      eligible.map((h) => diffHunks.get(h.id)!),
    );
    return { concepts, off_path: hunks.filter((h) => !placed.has(h.id)).map((h) => h.id) };
  };

  const briefingPass = async (concepts: Annotations["concepts"], hunks: AnnotatedHunk[]) => {
    const notRun = [
      ...unique(hunks.filter((h) => h.exec === "never_executed").map((h) => h.path)).map(
        (p) => `${p}: nothing ran after it changed`,
      ),
      ...det.warnings.filter((w) => w.kind === "failed_not_rerun").map((w) => w.detail),
    ];
    const reply = await ask(
      "briefing",
      BRIEFING_SYSTEM,
      {
        ...(ticket ? { ticket } : {}),
        prompts,
        plan,
        concepts: concepts.map((c) => c.title),
        warnings: det.warnings.map((w) => ({ kind: w.kind, detail: w.detail })),
        commands: commands(events),
        notRun,
      },
      BriefingReply,
    );
    return reply ? finishBriefing(reply, notRun.length > 0) : null;
  };

  const driftPass = async () => {
    const candidates = driftCandidates(live, hunksOf);
    if (candidates.length === 0) return new Set<string>();
    const reply = await ask("drift", DRIFT_SYSTEM, { intents: candidates }, DriftReply);
    return reply ? driftedHunks(reply, hunksOf) : new Set<string>();
  };

  const [rest, drifted] = await Promise.all([linksAndOn(), driftPass()]);
  const final = hunks.map((h) => (drifted.has(h.id) ? { ...h, drift: true } : h));

  return {
    hunks: final,
    intents: rest.intents,
    warnings: [
      ...det.warnings.filter((w) => w.kind !== "unexplained"),
      ...unexplained(final.filter((h) => h.serves === "unexplained")),
    ],
    read_first: det.read_first,
    off_path: rest.off_path,
    concepts: rest.concepts,
    briefing: rest.briefing,
    errors,
    enrich: { provider: provider.id, ...(model ? { model } : {}), prompt_version: PROMPT_VERSION },
    rejected,
  };
}

// The intent most of these edits belong to; the last one wins a tie.
function pick(intents: GroundedIntent[]): GroundedIntent | undefined {
  const counts = new Map<GroundedIntent, number>();
  for (const g of intents) counts.set(g, (counts.get(g) ?? 0) + 1);
  let best: GroundedIntent | undefined;
  for (const g of intents) if (!best || counts.get(g)! >= counts.get(best)!) best = g;
  return best;
}

// Model intents the hunks now point at, plus the recorded ones still in use.
function annotationIntents(
  live: GroundedIntent[],
  links: Map<string, Link>,
  recorded: Intent[],
  hunks: AnnotatedHunk[],
): Intent[] {
  const used = new Set(
    hunks.flatMap((h) => [...(h.intent_id ? [h.intent_id] : []), ...h.intent_history]),
  );
  return [
    ...live.map((g) => {
      const link = links.get(g.id)!;
      return {
        id: g.id,
        why: g.why,
        serves: link.serves,
        source_msg: g.source_msg,
        link_confidence: link.confidence,
      };
    }),
    ...recorded.filter((i) => used.has(i.id)),
  ];
}

// The files edited under each plan step, the parent side of a link check.
function planFiles(events: ModelInput["events"], planIds: string[]): Map<string, string[]> {
  const steps = planSteps(events);
  const out = new Map<string, string[]>(planIds.map((id) => [id, []]));
  for (const e of events) {
    if (e.type !== "edit") continue;
    const step = steps.get(e.id);
    if (step && out.has(step)) out.get(step)!.push(e.path);
  }
  return out;
}

// What pass 3 sees of a hunk: where it is, its first changed lines, and the
// rule facts.
function excerpt(a: AnnotatedHunk, h: Hunk) {
  const changed = h.lines.filter((l) => l.kind !== " ");
  return {
    id: a.id,
    path: a.path,
    header: `@@ -${a.old_start},${a.old_lines} +${a.new_start},${a.new_lines} @@`,
    lines: changed.slice(0, HUNK_EXCERPT).map((l) => l.kind + l.text),
    ...(changed.length > HUNK_EXCERPT ? { more_lines: changed.length - HUNK_EXCERPT } : {}),
    tags: [...a.risk, a.exec],
    intent_id: a.intent_id,
  };
}

// Each distinct command once, at its last run.
function commands(events: ModelInput["events"]) {
  const last = new Map<string, { cmd: string; exit: number; kind?: string }>();
  for (const e of events) {
    if (e.type !== "command") continue;
    const cmd = normalize(e.cmd);
    last.delete(cmd);
    last.set(cmd, { cmd, exit: e.exit, ...(e.kind ? { kind: e.kind } : {}) });
  }
  return [...last.values()];
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

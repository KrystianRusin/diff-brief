import type { BriefingInputs } from "../../briefing/inputs.js";
import type { Hunk } from "../../diff/index.js";
import type { Annotations } from "../../schema/annotations.js";
import type { EventOf } from "../../schema/events.js";
import {
  compileRule,
  DEFAULT_RISK_RULES,
  riskTags,
  tagWeights,
  type RiskRule,
} from "./risk-rules.js";
import { testGaps, type RepoTest } from "./test-gaps.js";
import { testWarnings } from "./test-rules.js";

// Facts that need no model, from the log and the diff (DB-11): whether a
// hunk's code ran after it was written, risk tags, deleted or weakened tests,
// commands that failed and were never re-run, and hunks nobody explained.
// The result merges straight into annotations.json, with or without the
// model passes.

export type Warning = Annotations["warnings"][number];
type AnnotatedHunk = Annotations["hunks"][number];
type Exec = AnnotatedHunk["exec"];

export type DeterministicResult = Pick<
  Annotations,
  "hunks" | "intents" | "warnings" | "read_first" | "off_path"
>;

const READ_FIRST = 3;
const CHECK_KINDS = new Set(["test", "build", "lint"]);

export function enrichDeterministic(
  inputs: Pick<BriefingInputs, "hunks" | "events" | "mapping">,
  // tests: the repo's test files on the final side; without them the
  // untested-change checks are skipped.
  opts: { rules?: RiskRule[]; tests?: RepoTest[]; read?: (path: string) => string | null } = {},
): DeterministicResult {
  const { hunks, events, mapping } = inputs;
  const rules = (opts.rules ?? DEFAULT_RISK_RULES).map(compileRule);
  const weights = tagWeights(rules);
  const timeline = touches(events);

  const annotated = hunks.map((h): AnnotatedHunk => {
    const m = mapping.byHunk[h.id];
    return {
      id: h.id,
      path: h.path,
      ...(h.oldPath ? { old_path: h.oldPath } : {}),
      status: h.status,
      old_start: h.oldStart,
      old_lines: h.oldLines,
      new_start: h.newStart,
      new_lines: h.newLines,
      content_hash: h.contentHash,
      why: null,
      intent_id: m?.intentId ?? null,
      intent_history: m?.history ?? [],
      ...(m?.serves ? { serves: m.serves } : {}),
      external_touched: m?.externalTouched ?? false,
      drift: false,
      exec: exec(h, m?.editIds ?? [], timeline),
      risk: riskTags(h, rules),
      source: { why: null, exec: "log", risk: "rules" },
    };
  });

  const offPath = annotated.filter((h) => h.serves === "unexplained").map((h) => h.id);
  const gaps = opts.tests
    ? testGaps(
        hunks,
        opts.tests,
        timeline.commands.some((c) => c.kind === "test"),
        opts.read,
      )
    : undefined;
  const warnings = [
    ...testWarnings(hunks),
    ...(gaps?.warnings ?? []),
    ...failedNotRerun(timeline.commands),
    ...unexplained(annotated.filter((h) => h.serves === "unexplained")),
  ];

  return {
    hunks: annotated,
    intents: intents(annotated, events),
    warnings,
    read_first: readFirst(annotated, hunks, weights, gaps?.untested ?? new Set()),
    off_path: offPath,
  };
}

type Command = EventOf<"command"> & { at: number };
type Timeline = {
  edits: Map<string, number>; // edit id → time
  fileTouches: Map<string, number[]>; // path → edit and external change times
  externals: Map<string, number[]>;
  commands: Command[]; // by time
};

function touches(events: BriefingInputs["events"]): Timeline {
  const t: Timeline = {
    edits: new Map(),
    fileTouches: new Map(),
    externals: new Map(),
    commands: [],
  };
  const push = (m: Map<string, number[]>, k: string, v: number) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (e.type === "edit") {
      t.edits.set(e.id, at);
      push(t.fileTouches, e.path, at);
      if (e.old_path) push(t.fileTouches, e.old_path, at);
    } else if (e.type === "external_change") {
      push(t.fileTouches, e.path, at);
      push(t.externals, e.path, at);
    } else if (e.type === "command") {
      t.commands.push({ ...e, at });
    }
  }
  t.commands.sort((a, b) => a.at - b.at);
  return t;
}

// Session-level evidence, not coverage: "tested" means a passing test ran
// after the hunk's last edit and nothing changed the file after that test.
function exec(h: Hunk, editIds: string[], t: Timeline): Exec {
  const paths = h.oldPath ? [h.path, h.oldPath] : [h.path];
  const editTimes = editIds.flatMap((id) => t.edits.get(id) ?? []);
  // No agent edit wrote it: date it by the file's last outside change.
  const own = editTimes.length ? editTimes : paths.flatMap((p) => t.externals.get(p) ?? []);
  if (own.length === 0) return "never_executed";
  const last = Math.max(...own);
  const fileLast = Math.max(last, ...paths.flatMap((p) => t.fileTouches.get(p) ?? []));

  if (t.commands.some((c) => c.kind === "test" && c.exit === 0 && c.at > fileLast)) return "tested";
  if (t.commands.some((c) => c.at > last)) return "ran";
  return "never_executed";
}

// Checks (test, build, lint) whose last run failed. A later passing run of the
// same command, or of a broader one it extends (`vitest run` after a failing
// `vitest run test/x`), counts as a re-run. Other commands are left out:
// grep and friends exit non-zero as a matter of course.
function failedNotRerun(commands: Command[]): Warning[] {
  const checks = commands.filter((c) => c.kind && CHECK_KINDS.has(c.kind));
  const last = new Map<string, Command>();
  for (const c of checks) last.set(normalize(c.cmd), c);

  const warnings: Warning[] = [];
  for (const [cmd, c] of last) {
    if (c.exit === 0) continue;
    const rerun = checks.some(
      (o) =>
        o.at > c.at && o.exit === 0 && (cmd === normalize(o.cmd) || covers(normalize(o.cmd), cmd)),
    );
    if (rerun) continue;
    const what = c.exit === -1 ? "was interrupted or blocked" : `failed (exit ${c.exit})`;
    warnings.push({
      kind: "failed_not_rerun",
      detail: `\`${cmd}\` ${what} and wasn't run again`,
      source: "log",
    });
  }
  return warnings;
}

// Output filters and redirects don't change what was checked.
export function normalize(cmd: string): string {
  let s = cmd.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\d?>&\d/g, "");
  for (;;) {
    const next = s.replace(/\s*\|\s*(?:tail|head|grep|less|more|tee|cut|sort|uniq|wc)\b[^|]*$/, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

function covers(broad: string, narrow: string): boolean {
  return narrow.startsWith(broad + " ");
}

// One warning per file, so a file of unexplained hunks reads as one item.
export function unexplained(hunks: AnnotatedHunk[], reason = "with no recorded reason"): Warning[] {
  const byPath = new Map<string, string[]>();
  for (const h of hunks) byPath.set(h.path, [...(byPath.get(h.path) ?? []), h.id]);
  return [...byPath].map(([path, ids]) => ({
    kind: "unexplained" as const,
    hunks: ids,
    detail: `${path}: ${ids.length} ${ids.length === 1 ? "hunk" : "hunks"} ${reason}`,
    source: "log" as const,
  }));
}

// riskWeight(tags) + 2 if never executed + 1 if unexplained + 1 if no test
// uses its file + log(size). Ties keep diff order.
function readFirst(
  annotated: AnnotatedHunk[],
  hunks: Hunk[],
  weights: Map<string, number>,
  untested: Set<string>,
): string[] {
  const score = annotated.map((h, i) => {
    const size = hunks[i]!.lines.filter((l) => l.kind !== " ").length;
    const risk = h.risk.reduce((n, tag) => n + (weights.get(tag) ?? 1), 0);
    return {
      id: h.id,
      s:
        risk +
        (h.exec === "never_executed" ? 2 : 0) +
        (h.serves === "unexplained" ? 1 : 0) +
        (untested.has(h.path) ? 1 : 0) +
        Math.log(1 + size),
    };
  });
  return score
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, READ_FIRST)
    .map((x) => x.id);
}

// The recorded intents the hunks point at, as annotation intents. Narration
// cites the message it came from; the model passes (DB-13) refine the rest.
function intents(
  annotated: AnnotatedHunk[],
  events: BriefingInputs["events"],
): Annotations["intents"] {
  const used = new Set(
    annotated.flatMap((h) => [...(h.intent_id ? [h.intent_id] : []), ...h.intent_history]),
  );
  const messages = new Map(
    events.flatMap((e) => (e.type === "agent_message" ? [[e.id, e] as const] : [])),
  );
  return events.flatMap((e) => {
    if (e.type !== "intent" || !used.has(e.id)) return [];
    const msg = e.msg_ref ? messages.get(e.msg_ref) : undefined;
    return [
      {
        id: e.id,
        why: e.why,
        serves: e.serves ?? "ticket",
        source_msg: msg ? { session: msg.session_id, msg_id: msg.id, quote: msg.text } : null,
      },
    ];
  });
}

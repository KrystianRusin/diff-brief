import { loadBriefingInputs, type BriefingInputs } from "../briefing/inputs.js";
import { finalPaths, targetContents } from "../diff/contents.js";
import { isTestFile } from "../enrich/deterministic/test-rules.js";
import type { RepoTest } from "../enrich/deterministic/test-gaps.js";
import type { Hunk } from "../diff/index.js";
import { enrichDeterministic, loadRiskRules, type RiskRule } from "../enrich/index.js";
import type { Annotations } from "../schema/annotations.js";
import type { EventOf } from "../schema/events.js";
import { findRepoRoot } from "../store/layout.js";
import type { TargetRequest } from "../target/index.js";

// Stopgap until the viewer (DB-16/17): prints the target's diff grouped by
// the recorded reason each hunk was mapped to (DB-08), with the deterministic
// facts (DB-11) first, so capture, mapping and the rules can be judged on
// real sessions. No model, no annotations file.

export type ShowOptions = TargetRequest & {
  diff?: boolean;
  full?: boolean;
  color?: boolean;
  rules?: RiskRule[];
  tests?: RepoTest[];
  read?: (path: string) => string | null;
};

// "test run after this change", not "covered" (DB-11).
const EXEC_LABEL: Record<AnnotatedHunk["exec"], [code: number, label: string]> = {
  tested: [32, "test run after"],
  ran: [33, "ran after, no passing test"],
  never_executed: [31, "nothing ran after"],
};

const WHY_LINES = 4;
const WHY_WIDTH = 160;
const DIFF_LINES = 8;

const SOURCE_LABEL: Record<EventOf<"intent">["source"], string> = {
  narration: "agent said",
  plan_step: "plan step",
  delegation: "delegated to a subagent",
  command_description: "command description",
  prompt: "prompt",
};

type Style = (code: number, s: string) => string;
type AnnotatedHunk = Annotations["hunks"][number];

export function renderShow(inputs: BriefingInputs, opts: ShowOptions = {}): string {
  const style: Style = opts.color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_, s) => s;
  const dim = (s: string) => style(2, s);
  const bold = (s: string) => style(1, s);
  const { resolved, hunks, stats, events, mapping } = inputs;
  const intents = new Map(events.flatMap((e) => (e.type === "intent" ? [[e.id, e] as const] : [])));
  const out: string[] = [];

  const { target } = resolved;
  const what =
    target.kind === "worktree"
      ? `Worktree vs ${short(target.base)}${resolved.branch ? ` (${resolved.branch})` : ""}`
      : target.kind === "commit"
        ? `Commit ${short(target.head)}`
        : `Range ${short(target.base)}..${short(target.head)}`;
  out.push(bold(what) + dim(` · ${stats.files} files, +${stats.insertions} -${stats.deletions}`));
  const starts = events.filter((e) => e.type === "session_start");
  out.push(
    dim(
      starts.length
        ? `Sessions: ${starts.map((s) => `${s.session_id.slice(0, 8)} (${when(s.ts)})`).join(", ")}`
        : "No recorded sessions touch this diff.",
    ),
  );
  if (hunks.length === 0) {
    out.push("", "Nothing to show: the diff is empty.");
    return out.join("\n") + "\n";
  }

  // One group per intent, in diff order of its first hunk; unexplained last.
  const groups = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const key = mapping.byHunk[h.id]?.intentId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const unexplained = groups.get("") ?? [];
  groups.delete("");
  out.push(
    dim(
      `${hunks.length} hunks: ${hunks.length - unexplained.length} explained by ${groups.size} ${groups.size === 1 ? "intent" : "intents"}, ${unexplained.length} unexplained`,
    ),
  );

  const det = enrichDeterministic(inputs, {
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.tests ? { tests: opts.tests } : {}),
    ...(opts.read ? { read: opts.read } : {}),
  });
  // A passing run says little about a file no test goes with.
  const noTest = new Set(
    det.warnings.flatMap((w) =>
      w.kind === "untested_change" || w.kind === "no_tests" ? (w.hunks ?? []) : [],
    ),
  );
  const facts = new Map(det.hunks.map((h) => [h.id, h]));
  const byId = new Map(hunks.map((h) => [h.id, h]));
  out.push("", style(1, "▸ read these first"));
  for (const id of det.read_first)
    out.push(`    ${hunkLine(byId.get(id)!, facts.get(id)!, noTest.has(id), style)}`);
  if (det.warnings.length) {
    out.push("", style(31, "▸ warnings"));
    for (const w of det.warnings) out.push(`  ${style(2, w.kind)}  ${w.detail}`);
  }

  for (const [intentId, hs] of groups) {
    const intent = intents.get(intentId);
    out.push("");
    if (intent) {
      out.push(style(36, `▸ ${SOURCE_LABEL[intent.source]}`) + dim(` · ${intentId}`));
      for (const line of whyLines(intent.why, opts.full)) out.push(`  ${line}`);
    } else {
      out.push(style(36, `▸ intent ${intentId}`) + dim(" (not in the log)"));
    }
    for (const h of hs) pushHunk(out, h, facts.get(h.id)!, noTest.has(h.id), inputs, opts, style);
  }

  if (unexplained.length) {
    out.push("", style(33, "▸ unexplained") + dim(" · no recorded edit wrote these lines"));
    for (const h of unexplained)
      pushHunk(out, h, facts.get(h.id)!, noTest.has(h.id), inputs, opts, style);
  }

  if (mapping.deadEnds.length) {
    out.push("", style(35, "▸ dead ends") + dim(" · edits that didn't survive into the diff"));
    for (const d of mapping.deadEnds) {
      const why = d.intentId ? intents.get(d.intentId)?.why : undefined;
      const first = why ? whyLines(why, false)[0] : "(no recorded reason)";
      out.push(`  ${dim(d.editId)}  ${first}`);
    }
  }
  return out.join("\n") + "\n";
}

function pushHunk(
  out: string[],
  h: Hunk,
  fact: AnnotatedHunk,
  noTest: boolean,
  inputs: BriefingInputs,
  opts: ShowOptions,
  style: Style,
): void {
  const notes = [
    ...(inputs.mapping.byHunk[h.id]?.mode === "file" ? ["matched by file"] : []),
    ...(fact.external_touched ? ["also changed outside the agent"] : []),
    ...(fact.intent_history.length ? [`earlier: ${fact.intent_history.join(", ")}`] : []),
  ];
  out.push(
    `    ${hunkLine(h, fact, noTest, style)}` +
      (notes.length ? style(2, `  ${notes.join(" · ")}`) : ""),
  );
  if (opts.diff === false) return;
  const lines = opts.full ? h.lines : h.lines.slice(0, DIFF_LINES);
  for (const l of lines) {
    const text = `      ${l.kind}${l.text}`;
    out.push(l.kind === "+" ? style(32, text) : l.kind === "-" ? style(31, text) : style(2, text));
  }
  if (lines.length < h.lines.length) {
    out.push(style(2, `      … ${h.lines.length - lines.length} more lines (--full)`));
  }
}

// Path, range, status, then the facts: exec and risk tags.
function hunkLine(h: Hunk, fact: AnnotatedHunk, noTest: boolean, style: Style): string {
  const range = h.lines.length
    ? ` @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`
    : "";
  const [code, label] =
    fact.exec === "tested" && noTest
      ? [33, "tests passed after, none for this file"]
      : EXEC_LABEL[fact.exec];
  return (
    `${style(1, h.path)}${style(2, range)}` +
    (h.status === "modified" ? "" : style(2, ` (${h.status})`)) +
    `  ${style(code, `[${label}]`)}` +
    (fact.risk.length ? `  ${style(35, fact.risk.map((t) => `#${t}`).join(" "))}` : "")
  );
}

function whyLines(why: string, full?: boolean): string[] {
  const lines = why
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (full) return lines;
  const kept = lines
    .slice(0, WHY_LINES)
    .map((l) => (l.length > WHY_WIDTH ? `${l.slice(0, WHY_WIDTH - 1)}…` : l));
  if (lines.length > WHY_LINES) kept.push(`… ${lines.length - WHY_LINES} more lines (--full)`);
  return kept;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function when(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

export function showAction(options: ShowOptions) {
  try {
    const root = findRepoRoot(process.cwd());
    if (!root) throw new Error("not inside a git repository");
    const inputs = loadBriefingInputs(root, options);
    const color = options.color ?? (process.stdout.isTTY && !process.env.NO_COLOR);
    const rules = loadRiskRules(root);
    process.stdout.write(
      renderShow(inputs, { ...options, color, rules, ...testFiles(root, inputs) }),
    );
  } catch (err) {
    console.error(`diffbrief show: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// The repo's test files on the diff's final side, and a reader for any file
// there, for the untested-change checks.
export function testFiles(root: string, inputs: BriefingInputs) {
  const contents = targetContents(root, inputs.resolved.spec);
  const read = (path: string) => contents.final(path)?.toString("utf8") ?? null;
  const tests = finalPaths(root, inputs.resolved.spec)
    .filter(isTestFile)
    .flatMap((path) => {
      const content = read(path);
      return content === null ? [] : [{ path, content }];
    });
  return { tests, read };
}

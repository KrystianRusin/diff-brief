import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomic } from "../../store/fs-util.js";
import { forgetOriginal, getOriginal, recordOriginal } from "../../store/install-record.js";
import type { AgentAdapter, DetectEnv, InstallOptions } from "../index.js";

// Installs the capture hooks (DB-05) into Claude Code's settings. We merge
// into the user's file rather than replacing it, and tag every command we
// write so re-runs and uninstall can find ours.

const LOCAL_SETTINGS = ".claude/settings.local.json";
const SHARED_SETTINGS = ".claude/settings.json";
const CLAUDE_MD = "CLAUDE.md";

// Trailing shell comment; Claude Code runs hook commands through a shell.
const MARKER = "# diffbrief";
const NUDGE = "Before each edit, say in one sentence why you're making it.";

// From DB-05's revised table: no PreToolUse, narration resolved per batch.
// No TaskCompleted either: the transcript walk sees the TaskUpdate itself.
const HOOKS: { event: string; matcher?: string }[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PostToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit" },
  { event: "PostToolUseFailure", matcher: "Bash" },
  { event: "PostToolBatch", matcher: "*" },
  { event: "TaskCreated" },
  { event: "SubagentStop" },
  { event: "Stop" },
  { event: "SessionEnd" },
];

type HookEntry = { type?: string; command?: unknown; [key: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [key: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

const isOurs = (h: HookEntry) => typeof h.command === "string" && h.command.endsWith(MARKER);
const groupHasOurs = (g: HookGroup) => Array.isArray(g.hooks) && g.hooks.some(isOurs);

function detect(root: string, env: DetectEnv): boolean {
  if (isDir(join(root, ".claude"))) return true;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  return env.pathDirs.some((dir) => names.some((n) => existsSync(join(dir, n))));
}

function install(root: string, opts: InstallOptions): string[] {
  const changes: string[] = [];
  const rel = opts.shared ? SHARED_SETTINGS : LOCAL_SETTINGS;
  const command = `${opts.cli} hook claude-code ${MARKER}`;

  const file = readSettings(root, rel);
  const next = structuredClone(file.settings);
  const hooks = (next.hooks ??= {});
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`${rel}: "hooks" is not an object; fix it by hand and re-run`);
  }

  const wanted = new Set(HOOKS.map((h) => h.event));
  for (const { event, matcher } of HOOKS) {
    const group: HookGroup = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command }],
    };
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`${rel}: hooks.${event} is not an array`);
    // Put ours back where it was so a re-run doesn't reorder the user's
    // entries. Groups before it hold none of ours, so the index survives.
    const at = groups.findIndex(groupHasOurs);
    const kept = withoutOurs(groups);
    kept.splice(at === -1 ? kept.length : at, 0, group);
    hooks[event] = kept;
  }
  // Events an older diffbrief registered but this one doesn't.
  for (const event of Object.keys(hooks)) {
    if (!wanted.has(event)) stripEvent(hooks, event);
  }

  if (!isDeepStrictEqual(next, file.settings)) {
    recordOriginal(root, rel, file.raw);
    writeFileAtomic(join(root, rel), serialize(next, file.raw));
    changes.push(`${rel}: ${file.raw === null ? "created with" : "added"} diffbrief hooks`);
  }

  if (opts.nudge) {
    const path = join(root, CLAUDE_MD);
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (!raw?.split("\n").includes(NUDGE)) {
      recordOriginal(root, CLAUDE_MD, raw);
      const sep = raw ? (raw.endsWith("\n") ? "\n" : "\n\n") : "";
      writeFileAtomic(path, (raw ?? "") + sep + NUDGE + "\n");
      changes.push(`${CLAUDE_MD}: added intent nudge`);
    }
  }
  return changes;
}

function uninstall(root: string): string[] {
  const changes: string[] = [];

  for (const rel of [LOCAL_SETTINGS, SHARED_SETTINGS]) {
    if (!existsSync(join(root, rel))) continue;
    const file = readSettings(root, rel);
    const hooks = file.settings.hooks;
    if (!hooks || typeof hooks !== "object") continue;
    const ours = Object.values(hooks).some((g) => Array.isArray(g) && g.some(groupHasOurs));
    if (!ours) continue;

    const stripped = structuredClone(file.settings);
    const strippedHooks = stripped.hooks!;
    for (const event of Object.keys(strippedHooks)) stripEvent(strippedHooks, event);
    if (Object.keys(strippedHooks).length === 0) delete stripped.hooks;

    // If nothing but our entries changed since install, put the original
    // bytes back. Otherwise keep the user's later edits and just drop ours.
    const original = getOriginal(root, rel);
    const originalSettings = original === null ? {} : original && tryParse(original);
    if (
      original !== undefined &&
      originalSettings &&
      sameIgnoringEmpty(stripped, originalSettings)
    ) {
      restore(root, rel, original);
    } else {
      writeFileAtomic(join(root, rel), serialize(stripped, file.raw));
    }
    forgetOriginal(root, rel);
    changes.push(`${rel}: removed diffbrief hooks`);
  }

  const mdPath = join(root, CLAUDE_MD);
  if (existsSync(mdPath)) {
    const raw = readFileSync(mdPath, "utf8");
    const lines = raw.split("\n");
    if (lines.includes(NUDGE)) {
      const stripped = lines.filter((l) => l !== NUDGE).join("\n");
      const original = getOriginal(root, CLAUDE_MD);
      if (original !== undefined && stripped.trimEnd() === (original ?? "").trimEnd()) {
        restore(root, CLAUDE_MD, original);
      } else {
        writeFileAtomic(mdPath, stripped);
      }
      forgetOriginal(root, CLAUDE_MD);
      changes.push(`${CLAUDE_MD}: removed intent nudge`);
    }
  }
  return changes;
}

// Remove our commands from one event, then any groups and the event itself
// if that leaves them empty. User-written hooks are never touched.
function stripEvent(hooks: Record<string, HookGroup[]>, event: string): void {
  const groups = hooks[event];
  if (!Array.isArray(groups) || !groups.some(groupHasOurs)) return;
  const kept = withoutOurs(groups);
  if (kept.length) hooks[event] = kept;
  else delete hooks[event];
}

function withoutOurs(groups: HookGroup[]): HookGroup[] {
  return groups.flatMap((g) => {
    if (!groupHasOurs(g)) return [g];
    const rest = (g.hooks ?? []).filter((h) => !isOurs(h));
    return rest.length ? [{ ...g, hooks: rest }] : [];
  });
}

// Settings equal once empty `hooks` containers are ignored, since stripping
// can't tell whether an empty one was the user's or ours.
function sameIgnoringEmpty(a: Settings, b: Settings): boolean {
  const prune = (s: Settings): Settings => {
    const out = structuredClone(s);
    if (out.hooks && typeof out.hooks === "object") {
      for (const [event, groups] of Object.entries(out.hooks)) {
        if (Array.isArray(groups) && groups.length === 0) delete out.hooks[event];
      }
      if (Object.keys(out.hooks).length === 0) delete out.hooks;
    }
    return out;
  };
  return isDeepStrictEqual(prune(a), prune(b));
}

function readSettings(root: string, rel: string): { raw: string | null; settings: Settings } {
  const path = join(root, rel);
  if (!existsSync(path)) return { raw: null, settings: {} };
  const raw = readFileSync(path, "utf8");
  const settings = tryParse(raw);
  if (!settings) throw new Error(`${rel} is not a JSON object; fix it by hand and re-run`);
  return { raw, settings };
}

function tryParse(raw: string): Settings | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Settings;
  } catch {
    // fall through
  }
  return undefined;
}

// Keep the file's existing indentation and trailing newline.
function serialize(settings: Settings, raw: string | null): string {
  const indent = raw?.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  const newline = raw === null || raw.endsWith("\n") ? "\n" : "";
  return JSON.stringify(settings, null, indent) + newline;
}

function restore(root: string, rel: string, original: string | null): void {
  const path = join(root, rel);
  if (original === null) rmSync(path, { force: true });
  else writeFileAtomic(path, original);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const claudeCode: AgentAdapter = {
  id: "claude-code",
  name: "Claude Code",
  detect,
  install,
  uninstall,
};

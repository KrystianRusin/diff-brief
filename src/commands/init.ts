import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { adapters } from "../adapters/index.js";
import { writeFileAtomic } from "../store/fs-util.js";
import { configPath, findRepoRoot, STORE_DIR } from "../store/layout.js";

export type InitOptions = {
  cwd: string;
  shared?: boolean;
  uninstall?: boolean;
  nudge?: boolean;
  // Shell prefix that runs this CLI. Defaults to resolveCli().
  cli?: string;
  pathDirs?: string[];
};

export type InitResult = { root: string; agents: string[]; changes: string[] };

export class InitError extends Error {}

const DEFAULT_CONFIG = {
  llm: { provider: "claude-headless", model: "claude-opus-5-5", concurrency: 3 },
};

const NPX = "npx --no-install diffbrief";

export function runInit(opts: InitOptions): InitResult {
  const root = findRepoRoot(opts.cwd);
  if (!root) throw new InitError("not inside a git repository; run `git init` first");
  if (!hasCommit(root)) {
    throw new InitError("the repository has no commits yet; diffbrief needs one to diff against");
  }

  const changes: string[] = [];

  if (opts.uninstall) {
    // Uninstall from every adapter, detected or not: the agent may be gone
    // while its config still holds our hooks.
    for (const a of adapters) changes.push(...a.uninstall(root));
    return { root, agents: [], changes };
  }

  const pathDirs = opts.pathDirs ?? (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const detected = adapters.filter((a) => a.detect(root, { pathDirs }));
  if (detected.length === 0) {
    const names = adapters.map((a) => a.name).join(", ");
    throw new InitError(`no supported agent found (looked for: ${names})`);
  }

  const cli = opts.cli ?? resolveCli(root, !!opts.shared);
  for (const a of detected) {
    changes.push(...a.install(root, { cli, shared: !!opts.shared, nudge: !!opts.nudge }));
  }
  if (ensureGitignored(root)) changes.push(`.gitignore: added ${STORE_DIR}/`);
  if (!existsSync(configPath(root))) {
    writeFileAtomic(configPath(root), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    changes.push(`${STORE_DIR}/config.json: created with defaults`);
  }
  return { root, agents: detected.map((a) => a.name), changes };
}

// Pointing straight at the installed cli.js skips npx's resolution on every
// hook call (DB-04). `node` is left to PATH so a Node upgrade doesn't break
// the hook. Inside the repo (node_modules, or diffbrief's own dist/ when
// dogfooding) the path is relative to $CLAUDE_PROJECT_DIR, which also makes it
// safe to commit. npx's cache is temporary, so that case falls back to npx.
export function resolveCli(root: string, shared: boolean, script = process.argv[1]): string {
  if (!script) return NPX;
  let path: string;
  try {
    path = realpathSync(script);
  } catch {
    return NPX;
  }
  const isBuiltCli = basename(path) === "cli.js" && basename(dirname(path)) === "dist";
  if (!isBuiltCli || path.includes(`${sep}_npx${sep}`)) return NPX;

  const rel = relative(realpathSync(root), path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return `node "$CLAUDE_PROJECT_DIR"/${shellQuote(rel.split(sep).join("/"))}`;
  }
  // A global install's path is specific to this machine.
  return shared ? NPX : `node ${shellQuote(path)}`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function hasCommit(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const IGNORE_PATTERNS = new Set([STORE_DIR, `${STORE_DIR}/`, `/${STORE_DIR}`, `/${STORE_DIR}/`]);

function ensureGitignored(root: string): boolean {
  const path = join(root, ".gitignore");
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (raw.split(/\r?\n/).some((l) => IGNORE_PATTERNS.has(l.trim()))) return false;
  const gap = raw === "" || raw.endsWith("\n") ? "" : "\n";
  writeFileAtomic(path, `${raw}${gap}${STORE_DIR}/\n`);
  return true;
}

export function initAction(options: { shared?: boolean; uninstall?: boolean; nudge?: boolean }) {
  try {
    const result = runInit({ cwd: process.cwd(), ...options });
    if (!options.uninstall) console.log(`Detected: ${result.agents.join(", ")}`);
    if (result.changes.length === 0) {
      console.log(
        options.uninstall ? "No diffbrief hooks found." : "Already set up; nothing changed.",
      );
    } else {
      for (const c of result.changes) console.log(`  ${c}`);
    }
    if (!options.uninstall) console.log("Run `diffbrief doctor` to check the setup.");
  } catch (err) {
    console.error(`diffbrief init: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

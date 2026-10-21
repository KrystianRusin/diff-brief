import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Everything diffbrief writes lives under <repo>/.diffbrief/. This module is
// the only place that knows the layout.

export const STORE_DIR = ".diffbrief";

// Session and briefing ids become directory names, so keep them to a safe
// character set. Claude Code session ids are UUIDs, which pass.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeId(id: string, what: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${what} id: ${JSON.stringify(id)}`);
}

export function storeDir(root: string): string {
  return join(root, STORE_DIR);
}

export function sessionsDir(root: string): string {
  return join(root, STORE_DIR, "sessions");
}

export function sessionDir(root: string, sessionId: string): string {
  assertSafeId(sessionId, "session");
  return join(sessionsDir(root), sessionId);
}

export function eventsPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "events.jsonl");
}

export function statePath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "state.json");
}

export function blobPath(root: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid blob hash: ${hash}`);
  return join(root, STORE_DIR, "blobs", hash.slice(0, 2), hash);
}

export function briefingDir(root: string, briefingId: string): string {
  assertSafeId(briefingId, "briefing");
  return join(root, STORE_DIR, "briefings", briefingId);
}

export function annotationsPath(root: string, briefingId: string): string {
  return join(briefingDir(root, briefingId), "annotations.json");
}

export function briefingCacheDir(root: string, briefingId: string): string {
  return join(briefingDir(root, briefingId), "cache");
}

export function logPath(root: string, name: string): string {
  assertSafeId(name, "log");
  return join(root, STORE_DIR, "logs", `${name}.log`);
}

export function configPath(root: string): string {
  return join(root, STORE_DIR, "config.json");
}

// Original contents of files `init` modified outside .diffbrief/, so
// `init --uninstall` can put them back exactly.
export function installRecordPath(root: string): string {
  return join(root, STORE_DIR, "install.json");
}

// Repo root for a working directory, or null outside a git repo.
export function findRepoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

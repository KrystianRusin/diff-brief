import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./fs-util.js";
import { installRecordPath } from "./layout.js";

// Remembers what a file looked like before `init` first touched it. Keyed by
// repo-relative path; null means the file didn't exist.

type InstallRecord = { originals: Record<string, string | null> };

function read(root: string): InstallRecord {
  try {
    const parsed = JSON.parse(readFileSync(installRecordPath(root), "utf8")) as InstallRecord;
    if (parsed && typeof parsed.originals === "object") return parsed;
  } catch {
    // Missing or corrupt: uninstall falls back to stripping our entries.
  }
  return { originals: {} };
}

// Only the first call per path is kept, so re-running init doesn't overwrite
// the real original with an already-modified version.
export function recordOriginal(root: string, relPath: string, content: string | null): void {
  const record = read(root);
  if (relPath in record.originals) return;
  record.originals[relPath] = content;
  writeFileAtomic(installRecordPath(root), JSON.stringify(record, null, 2) + "\n");
}

// undefined = nothing recorded for this path.
export function getOriginal(root: string, relPath: string): string | null | undefined {
  return read(root).originals[relPath];
}

export function forgetOriginal(root: string, relPath: string): void {
  const record = read(root);
  if (!(relPath in record.originals)) return;
  delete record.originals[relPath];
  const path = installRecordPath(root);
  if (Object.keys(record.originals).length === 0) {
    if (existsSync(path)) rmSync(path);
  } else {
    writeFileAtomic(path, JSON.stringify(record, null, 2) + "\n");
  }
}

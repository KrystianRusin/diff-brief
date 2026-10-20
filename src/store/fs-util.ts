import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Write to a sibling temp file then rename, so readers never see a partial file.
export function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// One appendFileSync call opens with O_APPEND and issues a single write. On a
// local filesystem concurrent appends of whole lines don't interleave.
export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}

import { dirname } from "node:path";
import { fs } from "./builtins.js";

const { appendFileSync, mkdirSync, renameSync, writeFileSync } = fs;

// Write to a sibling temp file then rename, so readers never see a partial file.
export function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  // pid keeps concurrent writers apart; the random part covers pid reuse. Not
  // crypto: loading it would cost the hook ~12 ms per call.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// One appendFileSync call opens with O_APPEND and issues a single write. On a
// local filesystem concurrent appends of whole lines don't interleave.
export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}

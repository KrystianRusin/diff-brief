import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeFileAtomic } from "./fs-util.js";
import { blobPath } from "./layout.js";

// Content-addressed file snapshots. Keys are sha256 of the raw content, so
// the same hash appears in events.jsonl as before_hash/after_hash.

export function hashContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function putBlob(root: string, content: Buffer | string): string {
  const hash = hashContent(content);
  const path = blobPath(root, hash);
  if (!existsSync(path)) writeFileAtomic(path, gzipSync(content));
  return hash;
}

export function hasBlob(root: string, hash: string): boolean {
  return existsSync(blobPath(root, hash));
}

export function getBlob(root: string, hash: string): Buffer {
  return gunzipSync(readFileSync(blobPath(root, hash)));
}

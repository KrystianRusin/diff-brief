import { crypto, fs, zlib } from "./builtins.js";
import { writeFileAtomic } from "./fs-util.js";
import { blobPath } from "./layout.js";

// Content-addressed file snapshots. Keys are sha256 of the raw content, so
// the same hash appears in events.jsonl as before_hash/after_hash.

export function hashContent(content: Buffer | string): string {
  return crypto().createHash("sha256").update(content).digest("hex");
}

export function putBlob(root: string, content: Buffer | string): string {
  const hash = hashContent(content);
  const path = blobPath(root, hash);
  if (!fs.existsSync(path)) writeFileAtomic(path, zlib().gzipSync(content));
  return hash;
}

export function hasBlob(root: string, hash: string): boolean {
  return fs.existsSync(blobPath(root, hash));
}

export function getBlob(root: string, hash: string): Buffer {
  return zlib().gunzipSync(fs.readFileSync(blobPath(root, hash)));
}

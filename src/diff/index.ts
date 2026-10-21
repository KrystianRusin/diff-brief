import { createHash } from "node:crypto";
import { runDiff, type DiffSpec } from "./git.js";
import { parseDiff, type DiffLine, type FileDiff, type FileStatus } from "./parse.js";

export { DiffError, emptyTree, type DiffSpec } from "./git.js";
export type { DiffLine, FileStatus } from "./parse.js";

// The single source of hunk identity: mapping (DB-08), enrich and its cache
// (DB-13, DB-15), follow-ups (DB-18) and the viewer all key on these ids.

export type Hunk = {
  id: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  contentHash: string;
};

export type DiffStats = { files: number; insertions: number; deletions: number };

export type DiffResult = { hunks: Hunk[]; stats: DiffStats };

export function computeDiff(root: string, spec: DiffSpec): DiffResult {
  return buildHunks(parseDiff(runDiff(root, spec)));
}

export function buildHunks(files: FileDiff[]): DiffResult {
  const hunks: Hunk[] = [];
  const seen = new Map<string, number>();
  const stats: DiffStats = { files: 0, insertions: 0, deletions: 0 };

  const push = (file: FileDiff, h: Omit<Hunk, "id" | "path" | "oldPath" | "status">) => {
    // Identical content at the same path (or a rare prefix clash elsewhere)
    // gets -2, -3 in diff order, keeping ids unique within the briefing.
    const base = hunkId(file.path, h.contentHash);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    hunks.push({
      id: n === 1 ? base : `${base}-${n}`,
      path: file.path,
      ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
      status: file.status,
      ...h,
    });
  };

  for (const file of files) {
    if (file.hunks.length === 0) {
      // A mode-only change has nothing to brief.
      if (file.status === "modified") continue;
      // Binary, pure rename, or empty file: one hunk with no lines, so the
      // file still shows up and can carry an intent.
      const contentHash =
        file.status === "binary"
          ? sha256(`binary:${file.newBlob ?? file.oldBlob ?? ""}`)
          : contentHashOf([]);
      push(file, { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [], contentHash });
    }
    for (const h of file.hunks) {
      push(file, { ...h, contentHash: contentHashOf(h.lines) });
      for (const l of h.lines) {
        if (l.kind === "+") stats.insertions++;
        else if (l.kind === "-") stats.deletions++;
      }
    }
    stats.files++;
  }
  return { hunks, stats };
}

// Whitespace-insensitive so reformatting or CRLF/LF churn alone doesn't change
// a hunk's identity.
function normalize(text: string): string {
  return text.replace(/\s+$/, "").replace(/\s+/g, " ");
}

// sha256 of the hunk's normalized added lines. A hunk with no (non-blank)
// added lines hashes its removed lines, "-"-prefixed, so it still gets a
// stable value distinct from a hunk adding the same text.
export function contentHashOf(lines: DiffLine[]): string {
  const pick = (kind: "+" | "-", prefix: string) =>
    lines
      .filter((l) => l.kind === kind)
      .map((l) => normalize(l.text))
      .filter((t) => t !== "")
      .map((t) => prefix + t);
  const added = pick("+", "");
  return sha256((added.length > 0 ? added : pick("-", "-")).join("\n"));
}

export function hunkId(path: string, contentHash: string): string {
  return "h" + sha256(path + contentHash).slice(0, 8);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

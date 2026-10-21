// Parser for the unified diff `runDiff` produces: `git diff` with fixed
// a/ b/ prefixes, --full-index, and -M.

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

export type DiffLine = {
  kind: "+" | "-" | " ";
  text: string; // without the newline; a CRLF file keeps its \r
  oldNo?: number;
  newNo?: number;
  noNewline?: true; // "\ No newline at end of file" follows this line
};

export type ParsedHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string; // new path; the old path for a deleted file
  oldPath?: string; // set for renames
  status: FileStatus;
  oldBlob?: string;
  newBlob?: string;
  hunks: ParsedHunk[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NULL_OID = /^0+$/;

export function parseDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let binary = false;
  let added = false;
  let deleted = false;

  const finish = () => {
    if (!file) return;
    if (binary) file.status = "binary";
    else if (file.oldPath !== undefined) file.status = "renamed";
    else if (added) file.status = "added";
    else if (deleted) file.status = "deleted";
    files.push(file);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;

    if (line.startsWith("diff --git ")) {
      finish();
      file = { path: headerPath(line.slice("diff --git ".length)), status: "modified", hunks: [] };
      binary = added = deleted = false;
      continue;
    }
    if (!file) continue;

    if (line.startsWith("@@")) {
      const m = HUNK_HEADER.exec(line);
      if (!m) throw new Error(`bad hunk header: ${line}`);
      const hunk: ParsedHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      // Read by count, so a removed "-- x" line (shown as "--- x") can't be
      // mistaken for a file header.
      let oldLeft = hunk.oldLines;
      let newLeft = hunk.newLines;
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i]!.startsWith("\\"))) {
        const l = lines[i++]!;
        if (l.startsWith("\\")) {
          const prev = hunk.lines.at(-1);
          if (prev) prev.noNewline = true;
          continue;
        }
        const kind = l[0] ?? " "; // an empty line is a blank context line
        const text = l.slice(1);
        if (kind === "+") {
          hunk.lines.push({ kind, text, newNo: newNo++ });
          newLeft--;
        } else if (kind === "-") {
          hunk.lines.push({ kind, text, oldNo: oldNo++ });
          oldLeft--;
        } else {
          hunk.lines.push({ kind: " ", text, oldNo: oldNo++, newNo: newNo++ });
          oldLeft--;
          newLeft--;
        }
      }
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("new file mode ")) added = true;
    else if (line.startsWith("deleted file mode ")) deleted = true;
    else if (line.startsWith("rename from ")) file.oldPath = unquote(line.slice(12));
    else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
    else if (line.startsWith("Binary files ")) binary = true;
    else if (line.startsWith("index ")) {
      const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
      if (m) {
        if (!NULL_OID.test(m[1]!)) file.oldBlob = m[1];
        if (!NULL_OID.test(m[2]!)) file.newBlob = m[2];
      }
    } else if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) {
      if (deleted) file.path = stripPrefix(markerPath(line), "a/");
    } else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      file.path = stripPrefix(markerPath(line), "b/");
    }
  }
  finish();
  return files;
}

// Path from "a/<p> b/<p>". Only needed when there are no ---/+++ or rename
// lines (binary, empty, mode-only), and then both sides are the same path:
// either both quoted, or both bare and the header splits evenly.
function headerPath(rest: string): string {
  if (rest.startsWith('"')) return stripPrefix(unquote(readQuoted(rest)), "a/");
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && rest.slice(n + 2, n + 5) === " b/") return rest.slice(2, n + 2);
  return stripPrefix(rest.split(" b/")[0]!, "a/");
}

// Path on a ---/+++ line. Git appends a tab to bare paths containing a space
// (for GNU patch); a path that really contains a tab is always quoted.
function markerPath(line: string): string {
  const raw = line.slice(4);
  return raw.startsWith('"') ? unquote(raw) : raw.replace(/\t$/, "");
}

function readQuoted(s: string): string {
  let end = 1;
  while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
  return s.slice(0, end + 1);
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

// Git C-quotes paths with control characters, quotes or backslashes (and, with
// core.quotepath on, non-ASCII bytes as octal escapes).
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const body = Array.from(s.slice(1, -1)); // code points, so surrogate pairs stay whole
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const next = body[++i] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3).join(""), 8));
      i += 2;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

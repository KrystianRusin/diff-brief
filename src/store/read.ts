import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseAnnotations, type Annotations } from "../schema/annotations.js";
import { parseEvent, type Event } from "../schema/events.js";
import { UnsupportedVersionError } from "../schema/version.js";
import { writeFileAtomic } from "./fs-util.js";
import { annotationsPath, eventsPath, sessionsDir } from "./layout.js";

// Read side of the store, used by enrich, the viewer, and the CLI. Validates
// everything against the DB-02 schemas.

export type SkippedLine = { line: number; reason: string };

export type ReadEventsResult = { events: Event[]; skipped: SkippedLine[] };

// Tolerant reader: a line that doesn't parse or validate is skipped and
// reported instead of failing the whole session. A truncated last line is
// expected after a crash mid-write. Lines from a newer diffbrief still throw,
// since silently dropping them would hide that an upgrade is needed.
export function readEvents(root: string, sessionId: string): ReadEventsResult {
  const path = eventsPath(root, sessionId);
  if (!existsSync(path)) return { events: [], skipped: [] };

  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const endsCleanly = text.endsWith("\n");
  if (endsCleanly) lines.pop();

  const events: Event[] = [];
  const skipped: SkippedLine[] = [];
  lines.forEach((raw, i) => {
    if (raw.trim() === "") return;
    const isLast = i === lines.length - 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      const reason = isLast && !endsCleanly ? "truncated last line" : "invalid JSON";
      skipped.push({ line: i + 1, reason });
      return;
    }
    try {
      events.push(parseEvent(json));
    } catch (err) {
      if (err instanceof UnsupportedVersionError) throw err;
      skipped.push({ line: i + 1, reason: "does not match event schema" });
    }
  });
  return { events, skipped };
}

export type SessionSummary = {
  id: string;
  agent?: string;
  branch?: string;
  ticket?: string;
  baseSha?: string;
  startedAt?: string;
  endedAt?: string;
  edits: number;
  commands: number;
};

export function summarizeSession(id: string, events: Event[]): SessionSummary {
  const summary: SessionSummary = { id, edits: 0, commands: 0 };
  for (const e of events) {
    if (e.type === "session_start") {
      summary.agent = e.agent;
      summary.branch = e.branch;
      summary.ticket = e.ticket;
      summary.baseSha = e.base_sha;
      summary.startedAt = e.ts;
    } else if (e.type === "session_end") {
      summary.endedAt = e.ts;
    } else if (e.type === "edit") {
      summary.edits++;
    } else if (e.type === "command") {
      summary.commands++;
    }
  }
  return summary;
}

// Newest first. Sessions missing a session_start sort last.
export function listSessions(root: string): SessionSummary[] {
  const dir = sessionsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => summarizeSession(d.name, readEvents(root, d.name).events))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export function readAnnotations(root: string, briefingId: string): Annotations | undefined {
  const path = annotationsPath(root, briefingId);
  if (!existsSync(path)) return undefined;
  return parseAnnotations(JSON.parse(readFileSync(path, "utf8")));
}

// Validates before writing so a bad enrich run can't leave an unreadable file.
export function writeAnnotations(root: string, briefingId: string, annotations: Annotations): void {
  const valid = parseAnnotations(annotations);
  writeFileAtomic(annotationsPath(root, briefingId), JSON.stringify(valid, null, 2) + "\n");
}

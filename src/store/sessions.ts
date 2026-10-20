import { readFileSync } from "node:fs";
import type { Event } from "../schema/events.js";
import { appendLine, writeFileAtomic } from "./fs-util.js";
import { eventsPath, logPath, statePath } from "./layout.js";

// Write side of the store. The capture hook imports this on every tool call,
// so it must not pull in zod or anything else heavy: events are trusted to
// match their TS type here and validated when read back.

export function appendEvent(root: string, sessionId: string, event: Event): void {
  appendLine(eventsPath(root, sessionId), JSON.stringify(event));
}

// Hook scratch state. The shape belongs to the adapter. A missing or corrupt
// file reads as undefined so the hook can start fresh instead of failing.
export function readState<T>(root: string, sessionId: string): T | undefined {
  try {
    return JSON.parse(readFileSync(statePath(root, sessionId), "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeState<T>(root: string, sessionId: string, state: T): void {
  writeFileAtomic(statePath(root, sessionId), JSON.stringify(state));
}

export function appendLog(root: string, name: string, message: string): void {
  appendLine(logPath(root, name), `${new Date().toISOString()} ${message}`);
}

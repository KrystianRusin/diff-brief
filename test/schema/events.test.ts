import { describe, expect, test } from "vitest";
import { parseEvent, parseEventLine, UnsupportedVersionError } from "../../src/schema/index.js";

const ts = "2026-10-20T15:00:00.000Z";
const hash = "a".repeat(64);

// The spec's example log, with ids as strings and the fields DB-02 adds.
const specEvents = [
  {
    v: 1,
    type: "session_start",
    ts,
    agent: "claude-code",
    session_id: "s1",
    base_sha: "a1b2c3",
    branch: "feat/123",
    ticket: "PROJ-123",
    prompt: "Fix the double discount",
    cwd: "/repo",
  },
  { v: 1, type: "prompt", ts, text: "also add a test" },
  {
    v: 1,
    type: "intent",
    ts,
    id: "i2",
    why: "…",
    serves: "i1",
    source: "narration",
    msg_ref: "42",
  },
  { v: 1, type: "agent_message", ts, id: "42", text: "I'll pull the discount into one place." },
  { v: 1, type: "read", ts, path: "src/auth/session.ts" },
  {
    v: 1,
    type: "edit",
    ts,
    id: "e1",
    path: "src/auth/session.ts",
    tool: "Edit",
    before_hash: hash,
    after_hash: "b".repeat(64),
    intent_id: "i2",
    msg_ref: "42",
  },
  {
    v: 1,
    type: "edit",
    ts,
    id: "e2",
    path: "new.ts",
    tool: "Write",
    before_hash: null,
    after_hash: hash,
  },
  { v: 1, type: "external_change", ts, path: "src/a.ts", before_hash: hash, after_hash: null },
  {
    v: 1,
    type: "command",
    ts,
    id: "c1",
    cmd: "npm test -- session",
    exit: 0,
    duration_ms: 8120,
    kind: "test",
  },
  { v: 1, type: "session_end", ts, transcript_path: "/tmp/t.jsonl" },
];

describe("events", () => {
  test.each(specEvents)("round-trips $type", (event) => {
    const line = JSON.stringify(event);
    expect(parseEventLine(line)).toEqual(event);
  });

  test("rejects a newer schema version with an upgrade hint", () => {
    expect(() => parseEvent({ ...specEvents[1], v: 2 })).toThrow(UnsupportedVersionError);
    expect(() => parseEvent({ ...specEvents[1], v: 2 })).toThrow(/Upgrade diffbrief/);
  });

  test("rejects missing or non-numeric v", () => {
    const { v: _v, ...noVersion } = specEvents[1]!;
    expect(() => parseEvent(noVersion)).toThrow();
    expect(() => parseEvent({ ...specEvents[1], v: "1" })).toThrow();
  });

  test("rejects unknown event type", () => {
    expect(() => parseEvent({ v: 1, type: "telemetry", ts })).toThrow();
  });

  test("rejects malformed hashes and timestamps", () => {
    expect(() => parseEvent({ ...specEvents[5], before_hash: "abc" })).toThrow();
    expect(() => parseEvent({ ...specEvents[1], ts: "yesterday" })).toThrow();
  });
});

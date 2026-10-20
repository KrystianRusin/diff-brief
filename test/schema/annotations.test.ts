import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseAnnotations, UnsupportedVersionError } from "../../src/schema/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/annotations/example.json", import.meta.url), "utf8"),
);
const clone = () => structuredClone(fixture);

describe("annotations", () => {
  test("fixture parses and round-trips unchanged", () => {
    expect(parseAnnotations(fixture)).toEqual(fixture);
  });

  test("partial briefing has null briefing and no model text", () => {
    const partial = clone();
    partial.status = "partial";
    partial.briefing = null;
    for (const h of partial.hunks) {
      h.why = null;
      h.source.why = null;
    }
    expect(() => parseAnnotations(partial)).not.toThrow();
  });

  test("rejects a newer schema version", () => {
    expect(() => parseAnnotations({ ...clone(), v: 2 })).toThrow(UnsupportedVersionError);
  });

  test("rejects references to unknown hunks", () => {
    const a = clone();
    a.read_first = ["hnope"];
    expect(() => parseAnnotations(a)).toThrow(/unknown hunk hnope/);

    const b = clone();
    b.concepts[0].path[1].hunks.push("hnope");
    expect(() => parseAnnotations(b)).toThrow(/unknown hunk hnope/);
  });

  test("rejects unknown intent ids and duplicate hunk ids", () => {
    const a = clone();
    a.hunks[0].intent_id = "x:i9";
    expect(() => parseAnnotations(a)).toThrow(/unknown intent x:i9/);

    const b = clone();
    b.hunks.push(b.hunks[0]);
    expect(() => parseAnnotations(b)).toThrow(/duplicate hunk ids/);
  });

  test("caps read_first at three hunks", () => {
    const a = clone();
    a.read_first.push(a.off_path[0]);
    expect(() => parseAnnotations(a)).toThrow();
  });

  test("worktree target must use the WORKTREE head", () => {
    const a = clone();
    a.target.head = "deadbeef";
    expect(() => parseAnnotations(a)).toThrow();
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Hunk } from "../../src/diff/index.js";
import { enrichDeterministic, loadRiskRules, RiskConfigError } from "../../src/enrich/index.js";
import {
  compileRule,
  DEFAULT_RISK_RULES,
  globToRegExp,
  riskTags,
  type RiskRule,
} from "../../src/enrich/deterministic/risk-rules.js";
import { testGaps } from "../../src/enrich/deterministic/test-gaps.js";
import { testWarnings } from "../../src/enrich/deterministic/test-rules.js";
import type { HunkMapping } from "../../src/mapping/index.js";
import { parseAnnotations } from "../../src/schema/annotations.js";
import type { Event } from "../../src/schema/events.js";
import type { MergedEvent } from "../../src/target/index.js";

let n = 0;
// A hunk from diff-style lines: "+added", "-removed", " context".
function hunk(path: string, lines: string[], opts: Partial<Hunk> = {}): Hunk {
  return {
    id: `${path}#${++n}`,
    path,
    status: "modified",
    oldStart: 1,
    oldLines: lines.filter((l) => l[0] !== "+").length,
    newStart: 1,
    newLines: lines.filter((l) => l[0] !== "-").length,
    lines: lines.map((l) => ({ kind: l[0] as "+" | "-" | " ", text: l.slice(1) })),
    contentHash: `h${n}`,
    ...opts,
  };
}

const rules = (r: RiskRule[] = DEFAULT_RISK_RULES) => r.map(compileRule);
const tags = (h: Hunk, r?: RiskRule[]) => riskTags(h, rules(r));

describe("globs", () => {
  test.each([
    ["**/*.sql", "db/001_init.sql", true],
    ["**/*.sql", "init.sql", true],
    ["**/migrations/**", "app/migrations/0001.py", true],
    ["**/migrations/**", "app/migrationsx/0001.py", false],
    ["src/*.ts", "src/a/b.ts", false],
    ["docker-compose*.{yml,yaml}", "docker-compose.prod.yaml", true],
    ["{package-lock.json,yarn.lock}", "yarn.lock", true],
    ["requirements*.txt", "requirements-dev.txt", true],
  ])("%s ~ %s → %s", (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want);
  });

  test("a glob without a slash matches the file name at any depth", () => {
    expect(tags(hunk("services/api/Dockerfile", ["+FROM node:22"]))).toContain("config");
  });
});

describe("risk rules", () => {
  test.each<[string, Hunk, Hunk]>([
    ["auth", hunk("src/auth/session.ts", ["+x"]), hunk("src/sessions.ts", ["+x"])],
    [
      "auth",
      hunk("src/api.ts", ["+  const jwt = sign(user);"]),
      hunk("src/git.ts", ["+  const author = commit.author;"]),
    ],
    ["migration", hunk("db/migrations/002.sql", ["+ALTER TABLE"]), hunk("db/seed.ts", ["+x"])],
    ["config", hunk(".github/workflows/ci.yml", ["+  run: npm test"]), hunk("src/ci.ts", ["+x"])],
    [
      "config",
      hunk("package.json", ['+    "zod": "^4.6.7",']),
      hunk("package.json", ['+    "build": "tsup",']),
    ],
    [
      "concurrency",
      hunk("src/a.ts", ["+  await Promise.all(jobs);"]),
      hunk("src/a.ts", ["+  await run(); // async, not concurrent"]),
    ],
    [
      "money",
      hunk("src/cart.ts", ["+  return price * qty;"]),
      hunk("src/cart.ts", ["+  return n;"]),
    ],
    [
      "public_api",
      hunk("src/a.ts", [
        "-export function f(a: string) {",
        "+export function f(a: string, b?: number) {",
      ]),
      hunk("src/a.ts", ["-  return a;", "+  return a.trim();"]),
    ],
    [
      "public_api",
      hunk("pkg/api.go", ["+func Serve(addr string) error {"]),
      hunk("pkg/api.go", ["+func serve(addr string) error {"]),
    ],
  ])("%s: tags the match, not the near miss", (tag, yes, no) => {
    expect(tags(yes)).toContain(tag);
    expect(tags(no)).not.toContain(tag);
  });

  test("deleted_code: over 20 changed lines, more than 70% removals", () => {
    const removals = (k: number) => Array.from({ length: k }, (_, i) => `-line ${i}`);
    expect(tags(hunk("src/a.ts", [...removals(22), "+x"]))).toContain("deleted_code");
    expect(tags(hunk("src/a.ts", removals(15)))).not.toContain("deleted_code");
    expect(
      tags(hunk("src/a.ts", [...removals(15), ...removals(10).map((l) => `+${l.slice(1)}`)])),
    ).not.toContain("deleted_code");
  });

  test("context lines don't count", () => {
    expect(tags(hunk("src/a.ts", [" const price = 1;", "+x"]))).not.toContain("money");
  });

  test("a rule with paths and lines needs both", () => {
    const r: RiskRule[] = [{ tag: "billing", paths: ["src/billing/**"], lines: ["charge"] }];
    expect(tags(hunk("src/billing/a.ts", ["+charge()"]), r)).toEqual(["billing"]);
    expect(tags(hunk("src/billing/a.ts", ["+refund()"]), r)).toEqual([]);
    expect(tags(hunk("src/other.ts", ["+charge()"]), r)).toEqual([]);
  });
});

describe("config", () => {
  const withConfig = (config: unknown) => {
    const root = mkdtempSync(join(tmpdir(), "diffbrief-rules-"));
    mkdirSync(join(root, ".diffbrief"));
    writeFileSync(join(root, ".diffbrief/config.json"), JSON.stringify(config));
    return root;
  };

  test("adds rules and turns default tags off", () => {
    const root = withConfig({
      llm: { provider: "x" },
      risk: { rules: [{ tag: "billing", paths: ["src/billing/**"] }], disable: ["money"] },
    });
    try {
      const loaded = loadRiskRules(root);
      expect(loaded.some((r) => r.tag === "money")).toBe(false);
      expect(tags(hunk("src/billing/a.ts", ["+price"]), loaded)).toEqual(["billing"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("a bad regex names its rule", () => {
    const root = withConfig({ risk: { rules: [{ tag: "oops", lines: ["("] }] } });
    try {
      expect(() => loadRiskRules(root)).toThrow(RiskConfigError);
      expect(() => loadRiskRules(root)).toThrow(/risk rule "oops"/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("no config file: the defaults", () => {
    expect(loadRiskRules(join(tmpdir(), "no-such-diffbrief-root"))).toBe(DEFAULT_RISK_RULES);
  });
});

describe("tests deleted or weakened", () => {
  const kinds = (hs: Hunk[]) => testWarnings(hs).map((w) => [w.kind, w.detail]);

  test("a deleted test file", () => {
    const h = hunk("test/a.test.ts", ['-it("works", () => {});'], { status: "deleted" });
    expect(kinds([h])).toEqual([["deleted_test", "test/a.test.ts: test file deleted"]]);
  });

  test("a removed test, unless it's declared again elsewhere", () => {
    const removed = hunk("test/a.test.ts", [
      '-test("rounds down", () => {',
      "-  expect(f(1.5)).toBe(1);",
    ]);
    expect(kinds([removed])).toEqual([
      ["deleted_test", 'test/a.test.ts: removed "rounds down"'],
      ["weakened_test", "test/a.test.ts: 1 assertion(s) removed, 0 added"],
    ]);
    const moved = hunk("test/b.test.ts", [
      '+test("rounds down", () => {',
      "+  expect(f(1.5)).toBe(1);",
    ]);
    expect(kinds([removed, moved]).map(([k]) => k)).toEqual(["weakened_test"]);
  });

  test("skips, focus, and lost assertions", () => {
    expect(kinds([hunk("test/a.test.ts", ['+it.skip("flaky", () => {});'])])).toEqual([
      ["weakened_test", "test/a.test.ts: skipped 1 test(s)"],
    ]);
    expect(
      kinds([hunk("tests/test_a.py", ["+@pytest.mark.skip", "+def test_x(): pass"])]).map(
        (x) => x[0],
      ),
    ).toEqual(["weakened_test"]);
    expect(kinds([hunk("test/a.test.ts", ['+describe.only("x", () => {'])])).toEqual([
      ["weakened_test", "test/a.test.ts: .only added, other tests won't run"],
    ]);
    expect(
      kinds([
        hunk("test/a.test.ts", [
          "-  expect(a).toBe(1);",
          "-  expect(b).toBe(2);",
          "+  expect(a).toBe(1);",
        ]),
      ]),
    ).toEqual([["weakened_test", "test/a.test.ts: 2 assertion(s) removed, 1 added"]]);
  });

  test("skip and .only inside a string aren't the real thing", () => {
    expect(
      kinds([hunk("test/rules.test.ts", ["+  check('it.skip(\"x\")', 'describe.only(');"])]),
    ).toEqual([]);
  });

  test("snapshot updates", () => {
    expect(kinds([hunk("test/__snapshots__/a.test.ts.snap", ["-old", "+new"])])).toEqual([
      ["weakened_test", "test/__snapshots__/a.test.ts.snap: snapshot updated"],
    ]);
  });

  test("ordinary changes to tests and to source raise nothing", () => {
    expect(
      kinds([
        hunk("test/a.test.ts", ['+test("new case", () => {', "+  expect(f(2)).toBe(2);"]),
        hunk("src/a.ts", ['-it("looks like a test", () => {});', "-  expect(x);"]),
      ]),
    ).toEqual([]);
  });
});

// A log for exec status and commands. Times are seconds from T0.
const T0 = Date.parse("2026-10-21T10:00:00Z");
const ts = (s: number) => new Date(T0 + s * 1000).toISOString();
const edit = (id: string, path: string, s: number): MergedEvent => ({
  v: 1,
  type: "edit",
  ts: ts(s),
  id,
  path,
  tool: "Edit",
  before_hash: null,
  after_hash: null,
  session_id: "sess",
});
const cmd = (
  id: string,
  s: number,
  command: string,
  exit: number,
  kind: "test" | "build" | "lint" | "other",
) =>
  ({
    v: 1,
    type: "command",
    ts: ts(s),
    id,
    cmd: command,
    exit,
    duration_ms: 1,
    kind,
    session_id: "sess",
  }) as MergedEvent;
const mapped = (editIds: string[], extra: Partial<HunkMapping> = {}): HunkMapping => ({
  history: [],
  externalTouched: false,
  editIds,
  mode: "line",
  ...extra,
});

function run(hunks: Hunk[], events: MergedEvent[], byHunk: Record<string, HunkMapping>) {
  return enrichDeterministic({ hunks, events, mapping: { byHunk, deadEnds: [] } });
}

describe("exec status", () => {
  const a = hunk("src/a.ts", ["+x"]);
  const exec = (events: MergedEvent[], ids = ["e1"]) =>
    run([a], events, { [a.id]: mapped(ids) }).hunks[0]!.exec;

  test("tested: a passing test after the last edit", () => {
    expect(exec([edit("e1", "src/a.ts", 1), cmd("c1", 2, "npm test", 0, "test")])).toBe("tested");
  });

  test("ran: a command after, but no passing test", () => {
    expect(exec([edit("e1", "src/a.ts", 1), cmd("c1", 2, "npm test", 1, "test")])).toBe("ran");
    expect(exec([edit("e1", "src/a.ts", 1), cmd("c1", 2, "npm run build", 0, "build")])).toBe(
      "ran",
    );
  });

  test("a later edit to the same file after the test undoes it", () => {
    const events = [
      edit("e1", "src/a.ts", 1),
      cmd("c1", 2, "npm test", 0, "test"),
      edit("e2", "src/a.ts", 3),
    ];
    expect(exec(events)).toBe("ran");
  });

  test("never_executed: nothing after the last edit", () => {
    expect(exec([cmd("c1", 0, "npm test", 0, "test"), edit("e1", "src/a.ts", 1)])).toBe(
      "never_executed",
    );
    expect(exec([], [])).toBe("never_executed");
  });
});

describe("failed and never re-run", () => {
  const warn = (events: MergedEvent[]) =>
    run([], events, {})
      .warnings.filter((w) => w.kind === "failed_not_rerun")
      .map((w) => w.detail);

  test("the last run of a check failed", () => {
    expect(
      warn([
        cmd("c1", 1, "npm test", 0, "test"),
        cmd("c2", 2, "npm test 2>&1 | tail -20", 1, "test"),
      ]),
    ).toEqual(["`npm test` failed (exit 1) and wasn't run again"]);
  });

  test("re-run and passing, or covered by a broader passing run", () => {
    expect(
      warn([cmd("c1", 1, "npm test", 1, "test"), cmd("c2", 2, "npm  test | tail -5", 0, "test")]),
    ).toEqual([]);
    expect(
      warn([
        cmd("c1", 1, "npx vitest run test/a", 1, "test"),
        cmd("c2", 2, "npx vitest run", 0, "test"),
      ]),
    ).toEqual([]);
  });

  test("interrupted checks are reported; other commands aren't", () => {
    expect(warn([cmd("c1", 1, "npm run build", -1, "build")])).toEqual([
      "`npm run build` was interrupted or blocked and wasn't run again",
    ]);
    expect(warn([cmd("c1", 1, "grep -r nothing src", 1, "other")])).toEqual([]);
  });
});

describe("merged into annotations", () => {
  test("unexplained hunks go off path, read_first ranks risk and never-run first, and it validates", () => {
    const risky = hunk("src/auth/login.ts", ["+  checkPassword(user);"]);
    const plain = hunk("src/a.ts", ["+x"]);
    const stray = hunk("src/b.ts", ["+y"]);
    const intent: Event = {
      v: 1,
      type: "intent",
      ts: ts(0),
      id: "sess:i1",
      why: "Fix login",
      source: "narration",
      msg_ref: "sess:m1",
    };
    const events: MergedEvent[] = [
      {
        v: 1,
        type: "agent_message",
        ts: ts(0),
        id: "sess:m1",
        text: "Fix login",
        session_id: "sess",
      },
      { ...intent, session_id: "sess" },
      edit("e1", "src/auth/login.ts", 1),
      edit("e2", "src/a.ts", 2),
      cmd("c1", 3, "npm test", 0, "test"),
    ];
    const det = run([plain, risky, stray], events, {
      [risky.id]: mapped(["e1"], { intentId: "sess:i1" }),
      [plain.id]: mapped(["e2"], { intentId: "sess:i1" }),
      [stray.id]: mapped([], { serves: "unexplained" }),
    });

    expect(det.off_path).toEqual([stray.id]);
    expect(det.warnings).toEqual([
      {
        kind: "unexplained",
        hunks: [stray.id],
        detail: "src/b.ts: 1 hunk with no recorded reason",
        source: "log",
      },
    ]);
    expect(det.read_first).toEqual([risky.id, stray.id, plain.id]);
    expect(det.intents).toEqual([
      {
        id: "sess:i1",
        why: "Fix login",
        serves: "ticket",
        source_msg: { session: "sess", msg_id: "sess:m1", quote: "Fix login" },
      },
    ]);

    const annotations = parseAnnotations({
      v: 1,
      briefing_id: "b1",
      target: { kind: "worktree", base: "abc1234", head: "WORKTREE" },
      sessions: ["sess"],
      generated_at: ts(10),
      status: "partial",
      errors: [],
      enrich: { provider: "none", prompt_version: "none" },
      briefing: null,
      concepts: [],
      ...det,
    });
    expect(annotations.hunks.map((h) => [h.path, h.exec, h.risk])).toEqual([
      ["src/a.ts", "tested", []],
      ["src/auth/login.ts", "tested", ["auth"]],
      ["src/b.ts", "never_executed", []],
    ]);
  });
});

describe("untested changes", () => {
  const code = (path: string) => hunk(path, ["+x"]);
  const t = (path: string, content = "") => ({ path, content });
  const gaps = (
    hunks: Hunk[],
    tests: { path: string; content: string }[],
    files: Record<string, string> = {},
    ranTests = false,
  ) => testGaps(hunks, tests, ranTests, (p) => files[p] ?? null);
  const details = (g: ReturnType<typeof gaps>) => g.warnings.map((w) => w.detail);

  test("a repo with no tests gets one warning, unless a test command ran", () => {
    const g = gaps([code("src/a.ts"), code("src/b.py")], []);
    expect(g.warnings.map((w) => [w.kind, w.hunks?.length])).toEqual([["no_tests", 2]]);
    expect([...g.untested]).toEqual(["src/a.ts", "src/b.py"]);
    // Rust keeps tests inside the source file; a test run is the only sign.
    expect(gaps([code("src/lib.rs")], [], {}, true).warnings).toEqual([]);
  });

  test("a changed test with the same name, or one that imports it, goes with the file", () => {
    const changedTest = hunk("test/order.test.js", ["+  expect(1);"]);
    expect(gaps([code("src/order.js"), changedTest], [t("test/order.test.js")]).warnings).toEqual(
      [],
    );

    const importer = hunk("test/checkout.test.ts", ["+x"]);
    const content = 'import { total } from "../src/cart/total.js";';
    expect(
      gaps([code("src/cart/total.ts"), importer], [t("test/checkout.test.ts", content)]).warnings,
    ).toEqual([]);
  });

  test("an existing test that wasn't touched is named; none at all marks the file untested", () => {
    const g = gaps(
      [code("src/a.ts"), code("src/b.ts")],
      [t("test/a.test.ts"), t("test/other.test.ts", 'import "../src/x.js";')],
    );
    expect(details(g)).toEqual([
      "src/a.ts: no test added or changed (test/a.test.ts uses it but wasn't touched)",
      "src/b.ts: no test added or changed, and no test file uses it",
    ]);
    expect([...g.untested]).toEqual(["src/b.ts"]);
  });

  test("an import one hop away counts: a test importing a barrel that re-exports the file", () => {
    const tests = [t("test/enrich.test.ts", 'import { f } from "../src/enrich/index.js";')];
    const files = { "src/enrich/index.ts": 'export { f } from "./deterministic/rules.js";' };
    expect(gaps([code("src/enrich/deterministic/rules.ts")], tests, files).untested.size).toBe(0);
    // Two hops is too far.
    const far = {
      "src/enrich/index.ts": 'export * from "./mid.js";',
      "src/enrich/mid.ts": 'export * from "./deep.js";',
    };
    expect(gaps([code("src/enrich/deep.ts")], tests, far).untested).toEqual(
      new Set(["src/enrich/deep.ts"]),
    );
  });

  test("python modules, go packages, and generic names", () => {
    expect(
      gaps(
        [code("app/billing/charge.py")],
        [t("tests/test_api.py", "from app.billing.charge import run")],
      ).untested.size,
    ).toBe(0);
    expect(
      gaps([code("pkg/server/serve.go")], [t("pkg/server/routes_test.go")]).untested.size,
    ).toBe(0);
    // index.ts says nothing about what's in it, so test/index.test.ts doesn't count.
    expect(gaps([code("src/enrich/index.ts")], [t("test/index.test.ts")]).untested.size).toBe(1);
  });

  test("helpers beside the tests, docs and config aren't code that needs a test", () => {
    const hs = [
      code("test/helpers/replay.ts"),
      code("README.md"),
      code("package.json"),
      code("tests/fixtures/a.py"),
    ];
    expect(gaps(hs, [t("test/a.test.ts")]).warnings).toEqual([]);
  });
});

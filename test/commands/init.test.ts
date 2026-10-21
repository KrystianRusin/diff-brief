import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InitError, resolveCli, runInit, type InitOptions } from "../../src/commands/init.js";
import { makeTempRepo, type TempRepo } from "../helpers/temp-repo.js";

const CLI = "/usr/bin/node /opt/diffbrief/dist/cli.js";
const OUR_COMMAND = `${CLI} hook claude-code # diffbrief`;
const LOCAL = ".claude/settings.local.json";
const NPX = "npx --no-install diffbrief";

let repo: TempRepo;
beforeEach(() => {
  repo = makeTempRepo();
  repo.write("README.md", "hi\n");
  repo.commit("init");
});
afterEach(() => repo.cleanup());

const init = (opts: Partial<InitOptions> = {}) =>
  runInit({ cwd: repo.dir, cli: CLI, pathDirs: [], ...opts });
const read = (path: string) => readFileSync(join(repo.dir, path), "utf8");
const exists = (path: string) => existsSync(join(repo.dir, path));
const withClaudeDir = () => mkdirSync(join(repo.dir, ".claude"), { recursive: true });

// Snapshot every file init can touch, to check re-runs change nothing.
const snapshot = () =>
  Object.fromEntries(
    [LOCAL, ".claude/settings.json", ".gitignore", "CLAUDE.md", ".diffbrief/config.json"].map(
      (p) => [p, exists(p) ? read(p) : null],
    ),
  );

const USER_SETTINGS =
  JSON.stringify(
    {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] },
        ],
      },
    },
    null,
    4,
  ) + "\n";

describe("preconditions", () => {
  test("refuses outside a git repo", () => {
    expect(() => runInit({ cwd: "/", cli: CLI, pathDirs: [] })).toThrow(InitError);
  });

  test("refuses a repo with no commits", () => {
    const empty = makeTempRepo();
    try {
      mkdirSync(join(empty.dir, ".claude"));
      expect(() => runInit({ cwd: empty.dir, cli: CLI, pathDirs: [] })).toThrow(/no commits/);
    } finally {
      empty.cleanup();
    }
  });

  test("refuses when no agent is detected", () => {
    expect(() => init()).toThrow(/no supported agent/);
  });

  test("detects Claude Code from `claude` on PATH", () => {
    repo.write("bin/claude", "");
    const result = init({ pathDirs: [join(repo.dir, "bin")] });
    expect(result.agents).toEqual(["Claude Code"]);
  });
});

describe("fresh repo", () => {
  test("writes hooks, gitignore, and config", () => {
    withClaudeDir();
    const result = init();
    expect(result.changes).toHaveLength(3);

    const settings = JSON.parse(read(LOCAL));
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "TaskCreated",
      "SubagentStop",
      "Stop",
      "SessionEnd",
    ]);
    expect(settings.hooks.PostToolUse).toEqual([
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: OUR_COMMAND }],
      },
    ]);
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: OUR_COMMAND }] }]);

    expect(read(".gitignore")).toBe(".diffbrief/\n");
    expect(JSON.parse(read(".diffbrief/config.json")).llm.provider).toBe("claude-headless");
    expect(repo.git("check-ignore", ".diffbrief/x")).toBe(".diffbrief/x");
  });

  test("re-run changes nothing", () => {
    withClaudeDir();
    init();
    const before = snapshot();
    expect(init().changes).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("uninstall removes the file it created", () => {
    withClaudeDir();
    init();
    init({ uninstall: true });
    expect(exists(LOCAL)).toBe(false);
    expect(exists(".diffbrief/install.json")).toBe(false);
  });
});

describe("existing hooks", () => {
  beforeEach(() => repo.write(LOCAL, USER_SETTINGS));

  test("keeps the user's hooks and settings", () => {
    init();
    const settings = JSON.parse(read(LOCAL));
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("prettier --write");
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe(OUR_COMMAND);
    // Keeps the file's 4-space indentation.
    expect(read(LOCAL)).toMatch(/^ {4}"permissions"/m);
  });

  test("re-run changes nothing", () => {
    init();
    const before = snapshot();
    expect(init().changes).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("uninstall restores the original byte-for-byte", () => {
    init();
    init({ nudge: true });
    expect(init({ uninstall: true }).changes).toHaveLength(2);
    expect(read(LOCAL)).toBe(USER_SETTINGS);
  });

  test("a new CLI path updates our entries in place", () => {
    init();
    // The user adds a hook after ours.
    const settings = JSON.parse(read(LOCAL));
    settings.hooks.PostToolUse.push({ hooks: [{ type: "command", command: "echo later" }] });
    repo.write(LOCAL, JSON.stringify(settings, null, 4) + "\n");

    init({ cli: "/new/node /new/dist/cli.js" });
    const commands = JSON.parse(read(LOCAL)).hooks.PostToolUse.map(
      (g: { hooks: { command: string }[] }) => g.hooks[0]!.command,
    );
    expect(commands).toEqual([
      "prettier --write",
      "/new/node /new/dist/cli.js hook claude-code # diffbrief",
      "echo later",
    ]);
  });

  test("uninstall keeps edits the user made after install", () => {
    init();
    const settings = JSON.parse(read(LOCAL));
    settings.model = "opus";
    repo.write(LOCAL, JSON.stringify(settings, null, 4) + "\n");

    init({ uninstall: true });
    const after = JSON.parse(read(LOCAL));
    expect(after.model).toBe("opus");
    expect(after.hooks).toEqual(JSON.parse(USER_SETTINGS).hooks);
  });

  test("refuses to touch a settings file that isn't valid JSON", () => {
    repo.write(LOCAL, "{ not json");
    expect(() => init()).toThrow(/not a JSON object/);
    expect(read(LOCAL)).toBe("{ not json");
  });
});

describe("options", () => {
  test("--shared writes settings.json with a portable command", () => {
    withClaudeDir();
    init({ shared: true, cli: undefined });
    expect(exists(LOCAL)).toBe(false);
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      "npx --no-install diffbrief hook claude-code # diffbrief",
    );
  });

  test("--nudge appends to CLAUDE.md once, and uninstall restores it", () => {
    withClaudeDir();
    const original = "# Project\n\nUse tabs.";
    repo.write("CLAUDE.md", original);
    init({ nudge: true });
    init({ nudge: true });
    expect(read("CLAUDE.md")).toBe(
      "# Project\n\nUse tabs.\n\nBefore each edit, say in one sentence why you're making it.\n",
    );
    init({ uninstall: true });
    expect(read("CLAUDE.md")).toBe(original);
  });

  test("gitignore entry is appended after a missing trailing newline", () => {
    withClaudeDir();
    repo.write(".gitignore", "node_modules");
    init();
    expect(read(".gitignore")).toBe("node_modules\n.diffbrief/\n");
  });

  test("an existing .diffbrief ignore pattern is left alone", () => {
    withClaudeDir();
    repo.write(".gitignore", "/.diffbrief\n");
    init();
    expect(read(".gitignore")).toBe("/.diffbrief\n");
  });

  test("an existing config is not overwritten", () => {
    withClaudeDir();
    repo.write(".diffbrief/config.json", '{"llm":{"provider":"fake"}}');
    init();
    expect(read(".diffbrief/config.json")).toBe('{"llm":{"provider":"fake"}}');
  });
});

describe("resolveCli", () => {
  test("falls back to npx when not running the built CLI", () => {
    expect(resolveCli(repo.dir, false, "/somewhere/src/cli.ts")).toBe(NPX);
    expect(resolveCli(repo.dir, false, undefined)).toBe(NPX);
  });

  test("a CLI inside the repo is addressed via $CLAUDE_PROJECT_DIR", () => {
    repo.write("node_modules/diffbrief/dist/cli.js", "");
    const cli = join(repo.dir, "node_modules/diffbrief/dist/cli.js");
    const expected = 'node "$CLAUDE_PROJECT_DIR"/node_modules/diffbrief/dist/cli.js';
    expect(resolveCli(repo.dir, false, cli)).toBe(expected);
    expect(resolveCli(repo.dir, true, cli)).toBe(expected);
  });

  test("a CLI outside the repo uses node from PATH, or npx when shared", () => {
    const other = makeTempRepo();
    try {
      other.write("dist/cli.js", "");
      const cli = join(other.dir, "dist/cli.js");
      expect(resolveCli(repo.dir, false, cli)).toBe(`node ${cli}`);
      expect(resolveCli(repo.dir, true, cli)).toBe(NPX);
    } finally {
      other.cleanup();
    }
  });
});

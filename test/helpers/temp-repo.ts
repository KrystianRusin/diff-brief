import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type TempRepo = {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  // `at` sets author and committer date, for tests that compare commit
  // times with session timestamps.
  commit(message: string, at?: Date): string;
  cleanup(): void;
};

// Isolate from the developer's global git config so tests behave the same everywhere.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "diffbrief-test",
  GIT_AUTHOR_EMAIL: "test@diffbrief.invalid",
  GIT_COMMITTER_NAME: "diffbrief-test",
  GIT_COMMITTER_EMAIL: "test@diffbrief.invalid",
};

export function makeTempRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "diffbrief-test-"));

  const run = (args: string[], env: NodeJS.ProcessEnv = gitEnv) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trimEnd();
  const git = (...args: string[]) => run(args);

  git("init", "--quiet", "--initial-branch=main");

  return {
    dir,
    git,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commit(message, at) {
      git("add", "-A");
      const date = at?.toISOString();
      run(
        ["commit", "--quiet", "--allow-empty", "-m", message],
        date ? { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : gitEnv,
      );
      return git("rev-parse", "HEAD");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

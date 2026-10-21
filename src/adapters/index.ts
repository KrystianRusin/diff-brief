import { claudeCode } from "./claude-code/install.js";

// Agent adapters known to `init`. Adding an agent (DB-22) means one adapter
// module plus one entry here.

export type InstallOptions = {
  // Shell prefix that runs the diffbrief CLI, e.g. `npx --no-install diffbrief`.
  cli: string;
  // Write config meant to be committed instead of the personal file.
  shared: boolean;
  // Ask the agent to state intent before each edit.
  nudge: boolean;
};

export type DetectEnv = { pathDirs: string[] };

export type AgentAdapter = {
  id: string;
  name: string;
  detect(root: string, env: DetectEnv): boolean;
  // Each returns a human-readable line per file changed; empty = nothing to do.
  install(root: string, opts: InstallOptions): string[];
  uninstall(root: string): string[];
};

export const adapters: AgentAdapter[] = [claudeCode];

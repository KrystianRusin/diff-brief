import { Command } from "commander";
import { initAction } from "./init.js";

function notImplemented(ticket: string) {
  return () => {
    console.error(`not implemented yet (${ticket})`);
    process.exitCode = 1;
  };
}

export function buildProgram(): Command {
  const program = new Command("diffbrief").description(
    "Shows an agent's diff with the reason for each change attached.",
  );

  program
    .command("init")
    .description("Write hook config for the detected agent and gitignore .diffbrief/")
    .option("--shared", "write .claude/settings.json (committed) instead of settings.local.json")
    .option("--nudge", "add a line to CLAUDE.md asking the agent to state intent before edits")
    .option("--uninstall", "remove diffbrief's hooks and nudge, restoring the original files")
    .action(initAction);

  program
    .command("view")
    .argument("[briefing]")
    .description("Start the local viewer and open the latest (or given) briefing")
    .action(notImplemented("DB-16"));

  program
    .command("list")
    .description("List briefings and recorded sessions")
    .action(notImplemented("DB-19"));

  program
    .command("enrich")
    .argument("[target]")
    .description("Re-run enrichment, e.g. after changing the model or prompt")
    .action(notImplemented("DB-15"));

  program
    .command("doctor")
    .description("Check hook install, git state, and LLM provider")
    .action(notImplemented("DB-19"));

  // Handled in cli.ts before commander loads; registered here only so it
  // shows up in --help.
  program
    .command("hook")
    .argument("<agent>")
    .description("Internal: receives agent hook events on stdin");

  return program;
}

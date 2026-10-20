#!/usr/bin/env node

// `hook` runs on every agent tool call, so it is dispatched before anything
// else is loaded. Every other command goes through commander.
const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  const { runHook } = await import("./commands/hook.js");
  await runHook(argv.slice(1));
} else {
  const { buildProgram } = await import("./commands/index.js");
  await buildProgram().parseAsync(process.argv);
}

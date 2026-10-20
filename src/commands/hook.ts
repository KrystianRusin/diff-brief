// Entry point for agent hooks. Must stay cheap to import and must never exit
// non-zero, so a diffbrief bug can't break the agent's tool call.
export async function runHook(args: string[]): Promise<void> {
  if (args.includes("--noop") || process.env.DIFFBRIEF_DISABLE === "1") return;
  // Adapter dispatch lands in DB-05.
}

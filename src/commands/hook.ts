// Entry point for agent hooks. Must stay cheap to import and must never exit
// non-zero or print, so a diffbrief bug can't break or steer the agent's tool
// call. Errors go to .diffbrief/logs/hook.log.
export async function runHook(args: string[]): Promise<void> {
  if (args.includes("--noop") || process.env.DIFFBRIEF_DISABLE === "1") return;
  try {
    if (args[0] !== "claude-code") return;
    const payload: unknown = JSON.parse(
      process.getBuiltinModule("node:fs").readFileSync(0, "utf8"),
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const { capture } = await import("../adapters/claude-code/capture.js");
    capture(payload as Record<string, unknown>);
  } catch {
    // Malformed stdin or a failure before we know the repo: nowhere to log.
  }
}

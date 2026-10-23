import { z } from "zod";
import type { Annotations } from "../../schema/annotations.js";

// Pass 4 (DB-13): the short briefing on the first screen. Its limits are
// enforced here, not trusted to the prompt: five lines or items per field.

export const BriefingReply = z.object({
  requirement: z.string(),
  approach: z.string(),
  assumptions: z.array(z.string()),
  not_run: z.array(z.string()),
});
export type BriefingReply = z.infer<typeof BriefingReply>;

const MAX = 5;

// hasNotRun: whether anything went unexecuted; without it, not_run is empty
// whatever the model says.
export function finishBriefing(
  reply: BriefingReply,
  hasNotRun: boolean,
): NonNullable<Annotations["briefing"]> {
  const items = (xs: string[]) =>
    xs
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, MAX);
  return {
    requirement: lines(reply.requirement),
    approach: lines(reply.approach),
    assumptions: items(reply.assumptions),
    not_run: hasNotRun ? items(reply.not_run) : [],
  };
}

function lines(s: string): string {
  return s.trim().split("\n").slice(0, MAX).join("\n");
}

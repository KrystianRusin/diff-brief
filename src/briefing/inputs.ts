import { targetContents } from "../diff/contents.js";
import { computeDiff } from "../diff/index.js";
import { mapHunks, type MappingMode } from "../mapping/index.js";
import { getBlob, hasBlob } from "../store/blobs.js";
import { listSessions } from "../store/read.js";
import { gatherSessions, resolveTarget, type TargetRequest } from "../target/index.js";

// Everything a briefing is built from, before any model runs: the resolved
// target, its diff, the sessions that fed it merged into one timeline, and
// each hunk's mapped intent.
export function loadBriefingInputs(
  root: string,
  req: TargetRequest,
  opts: { mode?: MappingMode } = {},
) {
  const resolved = resolveTarget(root, req, listSessions(root));
  const { hunks, stats } = computeDiff(root, resolved.spec);
  const { sessionIds, events, context } = gatherSessions(root, resolved, hunks);
  const mapping = mapHunks({
    hunks,
    events,
    contents: targetContents(root, resolved.spec),
    blob: (h) => (hasBlob(root, h) ? getBlob(root, h) : null),
    ...(resolved.baseTime !== undefined ? { baseTime: resolved.baseTime } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  return { resolved, hunks, stats, sessionIds, events, context, mapping };
}

export type BriefingInputs = ReturnType<typeof loadBriefingInputs>;

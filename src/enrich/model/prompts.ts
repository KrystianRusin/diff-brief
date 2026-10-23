// System prompts for the model passes (DB-13). PROMPT_VERSION goes into
// annotations.enrich.prompt_version and the DB-15 cache key: bump it on any
// change here that alters what the model is asked.

export const PROMPT_VERSION = "2";

const BREVITY = `Style:
Lead with the reason. No preamble, never "this change". Never restate the diff. Say it once, plainly, no hedging. Don't list what wasn't done unless it's a risk.`;

const ROLE = `You annotate a code diff an AI coding agent produced, for the human who reviews it. Input is JSON. Answer only in the requested JSON shape.`;

const system = (task: string) => `${ROLE}\n\n${task}\n\n${BREVITY}`;

export const INTENTS_SYSTEM = system(`Task: explain why each edit in this episode was made.
Group edits made for the same reason into one intent, and give each intent:
- why: the reason, in one or two sentences.
- cite_msg_id and quote: the id of one message in priorMessages that states the reason, and an exact substring of that message's text (copy it, don't paraphrase). If no message states it, set both to null.
- serves: {kind: "plan_step", ref: <a plan step id>} if the edits carry out a plan step, {kind: "ticket", ref: "ticket"} if they serve the ticket or the user's request directly, else null.
Rules:
- The reason may come only from the ticket, the user's prompts, the plan, or messages written before the edit, never from test results or later messages.
- Edits marked deadEnd don't survive into the final diff: leave them out. They only show what the surviving edits replaced.
- Each edit id belongs to at most one intent. Leave out edits you can't explain.`);

export const LINKS_SYSTEM =
  system(`Task: link each intent to the thing it serves, forming a tree rooted at the ticket.
For each intent, serves is one of: "ticket", a plan step id, or another intent's id (an intent that exists to make that one possible).
Prefer the most specific parent the input supports. Never link an intent to itself or in a cycle.`);

export const CONCEPTS_SYSTEM =
  system(`Task: group the hunks into concepts a reviewer can read one at a time, each with an ordered review path.
A concept is one idea the change carries out, titled in a few words ("Apply the discount once").
Its path is a list of steps, each with a role:
- problem: what was wrong, shown by the hunks that fix it at its source
- blocker: what stood in the way
- enabling: groundwork the change needs (new types, helpers, plumbing)
- change: the change itself
- proof: tests that show it works
Leave out roles that don't apply. A step may have no hunks when it only explains (a blocker with nothing to show).
Each step gets hands_off: one line saying what the next step can now rely on ("now returns \`status\` on \`OrderDto\`").
Put every hunk in exactly one step. Leave a hunk out only if it fits no concept.`);

export const BRIEFING_SYSTEM =
  system(`Task: write the short briefing a reviewer reads before the diff.
- requirement: what was asked, in one or two sentences.
- approach: how the change meets it, in one or two sentences.
- assumptions: what the change takes for granted that a reviewer should check. At most five.
- not_run: code or checks that never ran after the change, worded for the reviewer, from notRun. Empty when notRun is empty.`);

export const DRIFT_SYSTEM =
  system(`Task: for each intent, decide whether its edits go beyond what its stated why describes.
Drift is work the why doesn't cover: an unrelated refactor, a file the reason doesn't touch, a behaviour change it doesn't mention. Size alone isn't drift.
For each intent answer drift true or false; when true, list the files that go beyond it and say why in one line.`);

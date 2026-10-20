// Child process for the concurrent-append test: appends `count` large
// agent_message events tagged with this worker's id.
import { appendEvent } from "../../src/store/sessions.js";

const [root, sessionId, worker, count] = process.argv.slice(2) as [string, string, string, string];
const filler = "x".repeat(16 * 1024);

for (let i = 0; i < Number(count); i++) {
  appendEvent(root, sessionId, {
    v: 1,
    type: "agent_message",
    ts: new Date().toISOString(),
    id: `${worker}-${i}`,
    text: filler,
  });
}

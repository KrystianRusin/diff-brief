import { z } from "zod";
import { Annotations } from "./annotations.js";
import { Event } from "./events.js";

// JSON Schema files for non-TS adapters and renderers (e.g. the VS Code
// extension). Generated into schema/ by `npm run schema:export`.
export function jsonSchemas(): Record<string, unknown> {
  return {
    "events.v1.json": z.toJSONSchema(Event, { io: "input" }),
    "annotations.v1.json": z.toJSONSchema(Annotations, { io: "input" }),
  };
}

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { jsonSchemas } from "../../src/schema/json-schema.js";

test("checked-in JSON Schema files match the zod schemas", () => {
  for (const [name, schema] of Object.entries(jsonSchemas())) {
    const onDisk = JSON.parse(
      readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8"),
    );
    expect(onDisk, `schema/${name} is stale, run npm run schema:export`).toEqual(schema);
  }
});

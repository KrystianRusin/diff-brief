import { mkdirSync, writeFileSync } from "node:fs";
import { jsonSchemas } from "../src/schema/json-schema.js";

mkdirSync("schema", { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(`schema/${name}`, JSON.stringify(schema, null, 2) + "\n");
  console.log(`wrote schema/${name}`);
}

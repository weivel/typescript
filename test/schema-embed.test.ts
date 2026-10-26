import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { MANIFEST_SCHEMA_ID } from "../src/engine/schema.generated.js";

it("embeds the schema the model sibling publishes", () => {
  expect(MANIFEST_SCHEMA_ID).toBe("https://weivel.github.io/model/plugin.schema.json");
});

it("keeps the generated module out of git", () => {
  const result = spawnSync("git", ["check-ignore", "src/engine/schema.generated.ts"]);
  expect(result.status).toBe(0);
});

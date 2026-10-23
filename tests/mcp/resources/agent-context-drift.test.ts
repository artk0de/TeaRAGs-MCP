import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderAgentContextModule } from "../../../scripts/gen-agent-context.js";

const ROOT = resolve(__dirname, "../../..");
const MODULE_PATH = resolve(ROOT, "src/mcp/resources/generated/agent-context.ts");
const RULES_DIR = resolve(ROOT, "plugins/tea-rags/rules");

/**
 * Locks the committed agent-context module to the plugin markdown it is
 * generated from (Prettier-formatted, exactly as `npm run gen:agent-context`
 * writes it). Edit a rule without regenerating → this fails.
 */
describe("generated agent context drift guard", () => {
  it("matches the markdown it is generated from (run `npm run gen:agent-context` if this fails)", async () => {
    expect(readFileSync(MODULE_PATH, "utf8")).toBe(await renderAgentContextModule(RULES_DIR, MODULE_PATH));
  });
});

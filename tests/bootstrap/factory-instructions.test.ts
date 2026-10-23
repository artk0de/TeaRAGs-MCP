/**
 * Server `instructions` (harness context economy, Decision 5) — the always-on
 * core reaches the MCP client in the `initialize` result, within the budget.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../../src/bootstrap/factory.js";

vi.mock("../../src/core/api/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerAllTools: vi.fn(),
}));
vi.mock("../../src/mcp/resources/registry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerAllResources: vi.fn(),
}));
vi.mock("../../src/mcp/prompts/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerAllPrompts: vi.fn(),
}));

const INSTRUCTIONS_CAP = 4_096;
const SELF_CONTAINED_HEAD = 512;

async function initializeInstructions(server: McpServer): Promise<string | undefined> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "instructions-test", version: "0.0.0" });
  await client.connect(clientTransport);
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return instructions;
}

describe("createConfiguredServer instructions", () => {
  const ctx = { app: {} } as unknown as AppContext;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../src/mcp/resources/generated/agent-context.js");
  });

  it("sends the generated core as `instructions`, within the cap and self-contained in its head", async () => {
    const { AGENT_CONTEXT_CORE } = await import("../../src/mcp/resources/generated/agent-context.js");
    const { createConfiguredServer } = await import("../../src/bootstrap/factory.js");

    const instructions = await initializeInstructions(createConfiguredServer(ctx, null));

    expect(instructions).toBe(AGENT_CONTEXT_CORE === "" ? undefined : AGENT_CONTEXT_CORE);
    if (instructions !== undefined) {
      expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
      const head = instructions.slice(0, SELF_CONTAINED_HEAD);
      expect(head).toContain("project=");
      expect(head).toContain("path=");
    }
  });

  it("delivers a non-empty core to the client verbatim", async () => {
    vi.doMock("../../src/mcp/resources/generated/agent-context.js", () => ({
      AGENT_CONTEXT_CORE: "core: pass project= and path= on every read call",
      AGENT_CONTEXT_GUIDES: {},
    }));
    const { createConfiguredServer } = await import("../../src/bootstrap/factory.js");

    const instructions = await initializeInstructions(createConfiguredServer(ctx, null));

    expect(instructions).toBe("core: pass project= and path= on every read call");
  });
});

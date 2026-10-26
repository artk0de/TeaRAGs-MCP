/**
 * MCP_SERVER_INSTRUCTIONS (q1g6s.3) — `core` (default) sends the always-on core as
 * server `instructions`; `pointer` sends only the pointer line, for sessions where the
 * plugin's SessionStart hook already injects the full core.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAppConfig, parseAppConfigZod } from "../../src/bootstrap/config/index.js";
import type { AppContext } from "../../src/bootstrap/factory.js";
import { serverInstructions } from "../../src/mcp/resources/instructions.js";

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

describe("MCP_SERVER_INSTRUCTIONS config", () => {
  it("defaults to core", () => {
    expect(parseAppConfigZod({}).core.serverInstructions).toBe("core");
  });

  it("accepts pointer and carries it into AppConfig", () => {
    const zod = parseAppConfigZod({ MCP_SERVER_INSTRUCTIONS: "pointer" });
    expect(zod.core.serverInstructions).toBe("pointer");
    expect(buildAppConfig(zod).serverInstructions).toBe("pointer");
  });

  it("rejects any other value with the config layer's typed error", () => {
    expect(() => parseAppConfigZod({ MCP_SERVER_INSTRUCTIONS: "full" })).toThrow(
      /Invalid value.*for configuration field "core"/i,
    );
  });
});

describe("serverInstructions mode", () => {
  it("pointer mode returns only the pointer line, however small the core", () => {
    const out = serverInstructions("tiny core", undefined, "pointer");
    expect(out).toContain("tea-rags://guide/core");
    expect(out).not.toContain("tiny core");
    expect(out?.split("\n")).toHaveLength(1);
  });

  it("pointer mode keeps the empty-core contract (no instructions at all)", () => {
    expect(serverInstructions("", undefined, "pointer")).toBeUndefined();
  });

  it("core mode is the existing behaviour", () => {
    expect(serverInstructions("tiny core", undefined, "core")).toBe("tiny core");
    expect(serverInstructions("tiny core")).toBe("tiny core");
  });
});

describe("createConfiguredServer instructionsMode", () => {
  const ctx = { app: {} } as unknown as AppContext;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/mcp/resources/generated/agent-context.js", () => ({
      AGENT_CONTEXT_CORE: "core: pass project= and path= on every read call",
      AGENT_CONTEXT_GUIDES: {},
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../src/mcp/resources/generated/agent-context.js");
  });

  async function initializeInstructions(server: McpServer): Promise<string | undefined> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "instructions-mode-test", version: "0.0.0" });
    await client.connect(clientTransport);
    const instructions = client.getInstructions();
    await client.close();
    await server.close();
    return instructions;
  }

  it("sends the pointer line only when instructionsMode is pointer", async () => {
    const { createConfiguredServer } = await import("../../src/bootstrap/factory.js");
    const instructions = await initializeInstructions(
      createConfiguredServer(ctx, null, { instructionsMode: "pointer" }),
    );
    expect(instructions).toContain("tea-rags://guide/core");
    expect(instructions).not.toContain("pass project=");
  });

  it("sends the core when instructionsMode is omitted", async () => {
    const { createConfiguredServer } = await import("../../src/bootstrap/factory.js");
    const instructions = await initializeInstructions(createConfiguredServer(ctx, null));
    expect(instructions).toBe("core: pass project= and path= on every read call");
  });
});

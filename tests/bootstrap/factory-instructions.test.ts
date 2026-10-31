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

    const { serverInstructions } = await import("../../src/mcp/resources/instructions.js");
    expect(instructions).toBe(serverInstructions(AGENT_CONTEXT_CORE));
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

describe("serverInstructions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../src/mcp/resources/generated/agent-context.js");
  });

  const POINTER_URI = "tea-rags://guide/core";

  function longCore(): string {
    const sections = Array.from(
      { length: 40 },
      (_, i) => `## Section ${i}\n${`rule ${i}: pass project= and path= on every read call. `.repeat(3).trimEnd()}`,
    );
    return `# Core\nAddressing: pass project= and path=.\n\n${sections.join("\n\n")}\n`;
  }

  it("returns the core unchanged when it fits the cap", async () => {
    const { serverInstructions } = await import("../../src/mcp/resources/instructions.js");
    const core = "x".repeat(INSTRUCTIONS_CAP);

    expect(serverInstructions(core)).toBe(core);
  });

  it("returns undefined for an empty core", async () => {
    const { serverInstructions } = await import("../../src/mcp/resources/instructions.js");

    expect(serverInstructions("")).toBeUndefined();
  });

  it("cuts an oversized core on a blank-line boundary and ends with the resource pointer", async () => {
    const { serverInstructions } = await import("../../src/mcp/resources/instructions.js");
    const core = longCore();
    expect(core.length).toBeGreaterThan(INSTRUCTIONS_CAP);

    const instructions = serverInstructions(core) ?? "";

    expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    const lines = instructions.trimEnd().split("\n");
    const pointer = lines.at(-1) ?? "";
    expect(pointer).toContain(POINTER_URI);
    expect(pointer).toContain(`tea-rags resource ${POINTER_URI}`);
    const head = instructions.slice(0, instructions.lastIndexOf(pointer)).trimEnd();
    expect(core.startsWith(head)).toBe(true);
    expect(core.slice(head.length).startsWith("\n\n")).toBe(true);
    expect(head.length).toBeGreaterThan(INSTRUCTIONS_CAP / 2);
  });

  it("falls back to a line boundary when the core has no blank line", async () => {
    const { serverInstructions } = await import("../../src/mcp/resources/instructions.js");
    const core = Array.from({ length: 200 }, (_, i) => `line ${i}: pass project= and path=.`).join("\n");

    const instructions = serverInstructions(core) ?? "";

    expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    const head = instructions.slice(0, instructions.lastIndexOf("\n\n"));
    expect(core.startsWith(head)).toBe(true);
    expect(core.slice(head.length).startsWith("\n")).toBe(true);
  });

  it("cuts a list-only window before a list item, never inside one (bd tea-rags-mcp-9f0yn.9)", async () => {
    const { serverInstructions, splitCoreForInstructions } = await import("../../src/mcp/resources/instructions.js");
    const items = Array.from({ length: 120 }, (_, i) => `- row ${i}: pass project= and\n  path= on every read call`);
    const core = `# Core\n\n**Routing**\n\n${items.join("\n")}\n`;

    const split = splitCoreForInstructions(core);

    expect(split).toBeDefined();
    expect(split?.tail.startsWith("- row ")).toBe(true);
    expect(core.startsWith(split?.head ?? "-")).toBe(true);
    expect(core.endsWith(split?.tail ?? "-")).toBe(true);
    expect((split?.head.length ?? 0) + (split?.tail.length ?? 0) + 1).toBe(core.length);
    expect(serverInstructions(core)?.startsWith(`${split?.head}\n\n`)).toBe(true);
  });

  it("does not split a core that fits the cap", async () => {
    const { splitCoreForInstructions } = await import("../../src/mcp/resources/instructions.js");

    expect(splitCoreForInstructions("x".repeat(INSTRUCTIONS_CAP))).toBeUndefined();
  });

  it("keeps today's core instructions byte-identical to the pre-split cut (bd tea-rags-mcp-9f0yn.9)", async () => {
    const { AGENT_CONTEXT_CORE } = await import("../../src/mcp/resources/generated/agent-context.js");
    const { serverInstructions, splitCoreForInstructions } = await import("../../src/mcp/resources/instructions.js");
    const pointer = `Full rules continue in MCP resource ${POINTER_URI} (no MCP: \`tea-rags resource ${POINTER_URI}\`).`;
    // The cut serverInstructions made before the split existed: blank line in the window's
    // second half, else the last line boundary.
    const window = AGENT_CONTEXT_CORE.slice(0, INSTRUCTIONS_CAP - 2 - pointer.length + 1);
    const blankLine = window.lastIndexOf("\n\n");
    const cut = blankLine > window.length / 2 ? blankLine : window.lastIndexOf("\n");
    const legacyHead = AGENT_CONTEXT_CORE.slice(0, Math.max(cut, 0)).trimEnd();

    expect(AGENT_CONTEXT_CORE.length).toBeGreaterThan(INSTRUCTIONS_CAP);
    expect(serverInstructions(AGENT_CONTEXT_CORE)).toBe(`${legacyHead}\n\n${pointer}`);
    expect(splitCoreForInstructions(AGENT_CONTEXT_CORE)?.head).toBe(legacyHead);
  });

  it("sends a ≤ cap head of an oversized core as server instructions", async () => {
    const core = longCore();
    vi.doMock("../../src/mcp/resources/generated/agent-context.js", () => ({
      AGENT_CONTEXT_CORE: core,
      AGENT_CONTEXT_GUIDES: {},
    }));
    const { createConfiguredServer } = await import("../../src/bootstrap/factory.js");

    const instructions = await initializeInstructions(
      createConfiguredServer({ app: {} } as unknown as AppContext, null),
    );

    expect(instructions?.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    expect(instructions).toContain(POINTER_URI);
    expect(core.startsWith(instructions?.slice(0, 200) ?? "-")).toBe(true);
  });
});

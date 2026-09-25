// src/bootstrap/transport/in-memory.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * A client session on an MCP server living in the same process (bd
 * tea-rags-mcp-8vy3o). Requests travel the SDK's in-memory transport as
 * JSON-RPC messages, so the server side runs its full request path — tool
 * lookup, zod input validation, the handler, output-schema validation — and
 * the client side its own (it validates `structuredContent` against the
 * output schemas `listTools` announced), exactly as over stdio.
 */
export interface InProcessToolSession {
  listTools: () => Promise<Tool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** Disconnects both ends. Idempotent. */
  close: () => Promise<void>;
}

const CLIENT_INFO = { name: "tea-rags-call", version: "1.0.0" } as const;

/**
 * The SDK client aborts a request after 60 s by default. A one-shot CLI call
 * against a large index (architecture report, deep trace_path) can outlive
 * that; the budget here only bounds a genuinely hung server.
 */
const CALL_TIMEOUT_MS = 30 * 60_000;

export async function connectInProcessClient(server: McpServer): Promise<InProcessToolSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(CLIENT_INFO);
  await client.connect(clientTransport);

  let closed: Promise<void> | undefined;
  return {
    listTools: async () => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult,
    close: async () => {
      closed ??= (async () => {
        await client.close();
        await server.close();
      })();
      return closed;
    },
  };
}

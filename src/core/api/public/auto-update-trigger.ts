/**
 * Auto-update trigger port for the MCP search tools (hpg2, spec §3; bd
 * tea-rags-mcp-k7kmu C13). Implemented in bootstrap (composition root —
 * `auto-update/mcp-hint.ts`, where the freshness check and the detached
 * updater spawn live) and consumed structurally by mcp, so neither layer
 * imports the other: both type against this stable contract. `hintFor` fires
 * the freshness check + detached spawn behind the scenes and returns a
 * one-line hint for the response (or null). Contract: never throws, ~1 ms.
 */
export interface McpAutoUpdateTrigger {
  hintFor: (request: { collection?: string; project?: string; path?: string }) => string | null;
}

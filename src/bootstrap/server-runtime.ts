// src/bootstrap/server-runtime.ts
import type { PromptsConfig } from "../mcp/prompts/index.js";
import { getZodConfig, parseAppConfig, type AppConfig } from "./config/index.js";
import { createAppContext, loadPrompts, type AppContext } from "./factory.js";
import { migrateHomeDir } from "./migrate.js";

/** Everything an MCP server process needs before it builds its `McpServer`. */
export interface McpServerRuntime {
  config: AppConfig;
  ctx: AppContext;
  promptsConfig: PromptsConfig | null;
  /** Deprecated env vars in use, already reported on stderr. */
  deprecations: readonly { oldName: string; newName: string }[];
}

/**
 * The one runtime preparation every MCP server entry point runs — the stdio /
 * HTTP `server` command and the in-process `tea-rags call` session (bd
 * tea-rags-mcp-8vy3o) — so a tool called through either sees the same config,
 * the same AppContext and the same prompts.
 *
 * The context is built as the `server` env role: a server's env is every
 * served project's default, not an override of any one project's stamped
 * index shape (tea-rags-mcp-o0qsw).
 */
export async function prepareMcpServerRuntime(): Promise<McpServerRuntime> {
  migrateHomeDir();

  const config = parseAppConfig();
  const { deprecations } = getZodConfig();
  const ctx = await createAppContext(config, { ambientEnvRole: "server" });
  const promptsConfig = loadPrompts(config);

  if (deprecations.length > 0) {
    const lines = deprecations.map((d) => `  ${d.oldName} -> use ${d.newName}`).join("\n");
    console.error(`[tea-rags] Deprecated env vars:\n${lines}`);
  }

  return { config, ctx, promptsConfig, deprecations };
}

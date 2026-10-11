// src/bootstrap/server-runtime.ts
import type { PromptsConfig } from "../mcp/prompts/index.js";
import { getZodConfig, parseAppConfig, type AppConfig } from "./config/index.js";
import { createAppContext, createConfiguredServer, loadPrompts, type AppContext } from "./factory.js";
import { migrateHomeDir } from "./migrate.js";
import { startHttpServer } from "./transport/http.js";
import { startStdioServer } from "./transport/stdio.js";

/** Everything an MCP server process needs before it builds its `McpServer`. */
export interface McpServerRuntime {
  config: AppConfig;
  ctx: AppContext;
  promptsConfig: PromptsConfig | null;
  /** Deprecated env vars in use, already reported on stderr. */
  deprecations: readonly { oldName: string; newName: string }[];
}

/** What an MCP server entry point declares about its own lifetime. */
export interface McpServerRuntimeOptions {
  /**
   * Watch the working trees requests address, keeping their delta warm between
   * requests (`AppContextOptions.watchWorkingTrees`). Default `true` — a
   * long-lived server. The one-shot `tea-rags call` turns it off.
   */
  watchWorkingTrees?: boolean;
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
export async function prepareMcpServerRuntime(options: McpServerRuntimeOptions = {}): Promise<McpServerRuntime> {
  migrateHomeDir();

  const config = parseAppConfig();
  const { deprecations } = getZodConfig();
  const ctx = await createAppContext(config, {
    ambientEnvRole: "server",
    watchWorkingTrees: options.watchWorkingTrees ?? true,
  });
  const promptsConfig = loadPrompts(config);

  if (deprecations.length > 0) {
    const lines = deprecations.map((d) => `  ${d.oldName} -> use ${d.newName}`).join("\n");
    console.error(`[tea-rags] Deprecated env vars:\n${lines}`);
  }

  return { config, ctx, promptsConfig, deprecations };
}

/** What a caller of {@link runMcpServer} overrides about the server it starts. */
export interface McpServerRunOptions {
  /** Serve over HTTP regardless of the configured `transportMode` (`tea-rags server --http`). */
  http?: boolean;
}

/**
 * The one long-lived MCP server lifecycle both server entry points run — the
 * `tea-rags server` command and the `src/index.ts` script — so a lifecycle fix
 * (release on signals, stdin-close exit, deprecation reporting) lands once
 * (bd tea-rags-mcp-f3gq0).
 */
export async function runMcpServer(options: McpServerRunOptions = {}): Promise<void> {
  const { config, ctx, promptsConfig, deprecations } = await prepareMcpServerRuntime();

  // Graceful shutdown: disconnect embedding provider (daemon refcount--)
  const { cleanup } = ctx;
  if (cleanup) {
    const release = (): void => {
      void cleanup();
    };
    process.on("SIGTERM", release);
    process.on("SIGINT", release);
    process.on("beforeExit", release);
  }

  if (options.http || config.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    // bd tea-rags-mcp-e6cpu — stdin closing (or SIGTERM/SIGINT) releases
    // resources and then exits; the listeners above only release.
    await startStdioServer(server, { cleanup: ctx.cleanup });

    // Send deprecation warnings via MCP logging (visible to client)
    if (deprecations.length > 0) {
      const lines = deprecations.map((d) => `${d.oldName} -> use ${d.newName}`).join(", ");
      await server.sendLoggingMessage({ level: "warning", data: `Deprecated env vars: ${lines}` });
    }
  }
}

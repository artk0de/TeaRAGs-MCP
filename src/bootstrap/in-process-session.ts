// src/bootstrap/in-process-session.ts
import { createConfiguredServer } from "./factory.js";
import { prepareMcpServerRuntime } from "./server-runtime.js";
import { connectInProcessClient, type InProcessToolSession } from "./transport/in-memory.js";
import { releaseWithin } from "./transport/stdio.js";

/** Upper bound on how long `close()` waits for the AppContext to release. */
const RELEASE_TIMEOUT_MS = 5_000;

/**
 * Open a client session on a freshly built tea-rags MCP server in THIS
 * process (bd tea-rags-mcp-8vy3o) — the substrate of `tea-rags call`.
 *
 * The server is the one `tea-rags server` serves: same runtime preparation
 * (`prepareMcpServerRuntime`), same `createConfiguredServer`, so the tool set,
 * the codegraph gating, the schemas, the error middleware and the formatters
 * are the production ones. The single difference is the auto-update trigger,
 * which stays off — see `ConfiguredServerOptions.autoUpdate`.
 *
 * `close()` disconnects both transport ends and then releases the AppContext
 * (registry watcher, embedded-Qdrant ref, codegraph pools, git children),
 * bounded so a hanging release cannot keep a one-shot CLI alive.
 */
export async function openInProcessMcpSession(): Promise<InProcessToolSession> {
  const { ctx, promptsConfig } = await prepareMcpServerRuntime();
  const server = createConfiguredServer(ctx, promptsConfig, { autoUpdate: false });
  const session = await connectInProcessClient(server);

  let released: Promise<void> | undefined;
  return {
    listTools: session.listTools,
    callTool: session.callTool,
    close: async () => {
      released ??= (async () => {
        await session.close();
        await releaseWithin(ctx.cleanup, RELEASE_TIMEOUT_MS);
      })();
      return released;
    },
  };
}

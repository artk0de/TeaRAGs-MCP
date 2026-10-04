/**
 * Registry env replay for `tea-rags call` (bd tea-rags-mcp-nxwsq).
 *
 * The in-process server `call` builds parses its config from `process.env`,
 * exactly like `tea-rags server` — but a real server is spawned with the MCP
 * config's env block, and `call` runs in a bare shell. Without a replay the
 * project's registry-recorded knobs never reach the composition: a project
 * indexed with codegraph on served no graph tools (`Unknown tool`), and
 * `get_index_status` reported a false `CODEGRAPH_ENABLED: true -> false` drift.
 *
 * The replay is the one `index-codebase` and the auto-update runner use
 * (`resolveRegistryEnv`, invocation role: an explicit shell export wins, the
 * registry fills only unset groups). Unlike `index-codebase`, `call` never
 * borrows ANOTHER project's env for an unregistered target — it queries an
 * existing index, so there is no "new project" to seed.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/registry-env-code-defaults.js";
import { resolveBaseIndexEntry } from "../../core/api/index.js";
import { CollectionRegistry, resolveRegistryEnv, type CollectionEntry } from "../../core/api/public/index.js";

/** The request fields a tool addresses its project by — the MCP tool contract. */
function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The registered project a call targets: the `project` alias, else the
 * `collection`, else the entry whose index the server reads for the `path`
 * param, else for the cwd. A path or cwd resolves the way the server resolves a
 * request path (`resolveWorkingTree`): a linked worktree nobody registered
 * reads its repository's index, so its env is that entry's — the MCP contract
 * lets `path` alone address a worktree. Null when the target is not registered
 * or the path does not validate (the tool reports the bad path itself).
 */
export async function resolveCallProjectEntry(
  registry: CollectionRegistry,
  params: Record<string, unknown>,
  cwd: string,
): Promise<CollectionEntry | null> {
  const project = stringParam(params, "project");
  if (project) return registry.findByName(project);
  const collection = stringParam(params, "collection");
  if (collection) return registry.get(collection);
  try {
    return resolveBaseIndexEntry(registry, stringParam(params, "path") ?? cwd);
  } catch {
    // A path that does not validate addresses no entry; the tool itself
    // reports the bad path with its typed error.
    return null;
  }
}

/**
 * Seed `env` with the entry's registry env (identity fields + env snapshot +
 * Qdrant backend). Explicit values already in `env` win.
 *
 * @throws RegistryQdrantBackendUnresolvedError when the entry's records of its
 *   backend contradict each other — building the server on a half-applied env
 *   would query the wrong backend instead.
 */
export function applyCallProjectEnv(entry: CollectionEntry | null, env: NodeJS.ProcessEnv): void {
  Object.assign(env, resolveRegistryEnv(entry, env));
}

/** Production wiring for `CallDeps.prepareProjectEnv`: the user's registry, the process cwd and env. */
export async function prepareCallProjectEnv(params: Record<string, unknown>): Promise<void> {
  const registry = new CollectionRegistry(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), {
    envCodeDefaults: resolveRegistryEnvCodeDefaults,
  });
  applyCallProjectEnv(await resolveCallProjectEntry(registry, params, process.cwd()), process.env);
}

/**
 * Ambient working tree for read tools (bd tea-rags-mcp-d0z7b.8).
 *
 * A stdio MCP server is spawned by its client in the client's working
 * directory (Claude Code launches it from the project dir), so the server
 * process cwd IS the project a request with no addressing means. A read tool
 * called with no `project` / `path` / `collection` is addressed by that cwd —
 * the same `path` resolution an explicit request gets — when a registered
 * project claims it; otherwise the request fails naming the cwd, so the agent
 * learns which `path` to pass.
 *
 * Scope is deliberately narrow:
 * - read tools only (`readOnlyHint: true`) that accept `path` — a mutating
 *   tool (index_codebase, clear_index, delete_*) never gains an implicit target;
 * - only servers whose cwd means something: the composition root passes an
 *   `AmbientWorkingTree` for stdio and the in-process `tea-rags call`, never for
 *   HTTP, whose process cwd is unrelated to the remote client.
 */

import { CollectionNotProvidedError, type CollectionEntry } from "../../public/index.js";
import type { McpToolResult } from "../format.js";

export interface AmbientWorkingTree {
  /** The server process cwd — the client's project dir under stdio. */
  cwd: string;
  /**
   * The registry entry whose index a request addressed by `path` alone is
   * served from (`App#resolveBaseIndexEntry` over the live registry). Null when
   * no entry claims it; may throw on a path that does not validate.
   */
  resolveIndexEntry: (path: string) => CollectionEntry | null;
}

interface AddressedToolConfig {
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

const ADDRESSING_KEYS = ["project", "path", "collection"] as const;

function inputKeys(schema: unknown): readonly string[] {
  if (schema === null || typeof schema !== "object") return [];
  // A raw zod shape lists its params as keys; a zod object schema under `.shape`.
  const { shape } = schema as { shape?: unknown };
  return Object.keys(shape !== null && typeof shape === "object" ? shape : schema);
}

function isAddressed(args: unknown): boolean {
  if (args === null || typeof args !== "object") return false;
  const record = args as Record<string, unknown>;
  return ADDRESSING_KEYS.some((key) => typeof record[key] === "string" && record[key] !== "");
}

function claimedByRegistry(ambient: AmbientWorkingTree): boolean {
  try {
    return ambient.resolveIndexEntry(ambient.cwd) !== null;
  } catch {
    // A cwd that does not validate addresses no entry.
    return false;
  }
}

/**
 * Wrap a tool handler so an unaddressed read request is addressed by the
 * ambient cwd. Returns the handler unchanged when the tool is not an
 * addressable read tool or the server has no ambient cwd.
 */
export function withAmbientWorkingTree<T, E>(
  config: AddressedToolConfig,
  handler: (args: T, extra: E) => Promise<McpToolResult>,
  ambient: AmbientWorkingTree | undefined,
): (args: T, extra: E) => Promise<McpToolResult> {
  if (ambient === undefined) return handler;
  if (config.annotations?.readOnlyHint !== true) return handler;
  if (!inputKeys(config.inputSchema).includes("path")) return handler;
  return async (args, extra) => {
    if (isAddressed(args)) return handler(args, extra);
    if (!claimedByRegistry(ambient)) throw new CollectionNotProvidedError(ambient.cwd);
    return handler({ ...(args as object), path: ambient.cwd } as T, extra);
  };
}

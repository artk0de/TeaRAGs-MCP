import { homedir } from "node:os";
import { join } from "node:path";

import { resolveRegistryEnvCodeDefaults } from "../bootstrap/config/index.js";
import {
  CollectionRegistry,
  EMBEDDED_MARKER,
  ProjectNotRegisteredError,
  ProjectPathMissingError,
  resolveRegistryQdrantBackend,
  type CollectionEntry,
} from "../core/api/public/index.js";

export interface ProjectAwareArgs {
  project?: string;
  path?: string;
  "qdrant-url"?: string;
  "embedding-url"?: string;
  "embedding-fallback-url"?: string;
  model?: string;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/**
 * The `--qdrant-url` an entry's backend implies. The embedded daemon comes back
 * as the `embedded` marker the URL resolvers re-resolve against the live daemon
 * — never as the frozen `127.0.0.1:<port>` a pre-sentinel entry stored, which
 * is dead after the first daemon restart (bd tea-rags-mcp-lzynm).
 *
 * @throws RegistryQdrantBackendUnresolvedError when the entry contradicts itself.
 */
function registryQdrantUrlArg(entry: CollectionEntry): string | undefined {
  const backend = resolveRegistryQdrantBackend(entry);
  if (backend.kind === "embedded") return EMBEDDED_MARKER;
  return backend.kind === "external" ? backend.url : undefined;
}

/**
 * Resolve --path / --qdrant-url / --embedding-url / --embedding-fallback-url /
 * --model defaults from the project registry when the caller passed --project.
 * The function throws typed InputValidationError subclasses (not process.exit)
 * so callers can catch and present the failure in their own UX (CLI, JSON, MCP).
 *
 * The embedding endpoints are resolved from their DEDICATED CollectionEntry
 * fields, the same source `resolveRegistryEnv` composes into its replay set —
 * they are identity keys and never appear in `entry.env`. A consumer that
 * replays only `entry.env` (`tune`) would otherwise fall through to the
 * localhost:11434 default and calibrate against the wrong backend.
 *
 * Empty-string values stored in the registry (recovered stubs from
 * `tea-rags doctor --recover-registry`) are coerced to undefined before
 * nullish-coalesce so downstream code falls through to its own defaults
 * instead of being poisoned with `""`. Audit #5.
 *
 * @throws ProjectNotRegisteredError when --project names an alias not in the
 *   registry.
 * @throws ProjectPathMissingError when the registry entry exists but its
 *   path field is empty (recovered stub awaiting re-registration).
 */
export function applyProjectDefaults<A extends ProjectAwareArgs>(argv: A): A {
  if (!argv.project) return argv;
  const registry = new CollectionRegistry(resolveDataDir(), { envCodeDefaults: resolveRegistryEnvCodeDefaults });
  const entry = registry.findByName(argv.project);
  if (!entry) {
    const names = registry
      .list()
      .map((e) => e.name)
      .filter((n): n is string => n !== null);
    throw new ProjectNotRegisteredError(argv.project, names);
  }
  if (entry.path === "") {
    throw new ProjectPathMissingError(
      argv.project,
      `Run: tea-rags projects register --path <dir> --name ${argv.project}`,
    );
  }
  return {
    ...argv,
    path: argv.path ?? entry.path,
    "qdrant-url": argv["qdrant-url"] ?? registryQdrantUrlArg(entry),
    "embedding-url": argv["embedding-url"] ?? (entry.embeddingBaseUrl || undefined),
    "embedding-fallback-url": argv["embedding-fallback-url"] ?? (entry.embeddingFallbackUrl || undefined),
    model: argv.model ?? (entry.embeddingModel || undefined),
  };
}

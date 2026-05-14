import { homedir } from "node:os";
import { join } from "node:path";

import { ProjectNotRegisteredError, ProjectPathMissingError } from "../core/api/errors.js";
import { CollectionRegistry } from "../core/infra/registry/collection-registry.js";

export interface ProjectAwareArgs {
  project?: string;
  path?: string;
  "qdrant-url"?: string;
  model?: string;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/**
 * Resolve --path / --qdrant-url / --model defaults from the project registry
 * when the caller passed --project. The function throws typed
 * InputValidationError subclasses (not process.exit) so callers can catch
 * and present the failure in their own UX (CLI, JSON, MCP).
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
  const registry = new CollectionRegistry(resolveDataDir());
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
    "qdrant-url": argv["qdrant-url"] ?? (entry.qdrantUrl || undefined),
    model: argv.model ?? (entry.embeddingModel || undefined),
  };
}

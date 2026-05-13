import { homedir } from "node:os";
import { join } from "node:path";

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

export function applyProjectDefaults<A extends ProjectAwareArgs>(argv: A): A {
  if (!argv.project) return argv;
  const registry = new CollectionRegistry(resolveDataDir());
  const entry = registry.findByName(argv.project);
  if (!entry) {
    const names = registry
      .list()
      .map((e) => e.name)
      .filter((n): n is string => n !== null);
    process.stderr.write(`Project '${argv.project}' not registered. Available: ${names.join(", ") || "(none)"}\n`);
    process.exit(1);
  }
  return {
    ...argv,
    path: argv.path ?? entry.path,
    "qdrant-url": argv["qdrant-url"] ?? entry.qdrantUrl,
    model: argv.model ?? entry.embeddingModel,
  };
}

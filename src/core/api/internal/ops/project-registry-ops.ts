import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/collection-registry.js";
import type { ProjectInfo } from "../../../infra/registry/types.js";
import { PathDoesNotExistError, ProjectNameInvalidError, ProjectNameNotUniqueError } from "../../errors.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ProjectRegistryOpsDeps {
  registry: CollectionRegistry;
}

export class ProjectRegistryOps {
  constructor(private readonly deps: ProjectRegistryOpsDeps) {}

  async register(input: { path: string; name: string }): Promise<{ collectionName: string; alreadyIndexed: boolean }> {
    if (!input.name || input.name.length === 0) {
      throw new ProjectNameInvalidError(input.name, "empty");
    }
    if (input.name.length > 64) {
      throw new ProjectNameInvalidError(input.name, "tooLong");
    }
    if (!NAME_RE.test(input.name)) {
      throw new ProjectNameInvalidError(input.name, "regex");
    }
    if (!existsSync(resolve(input.path))) {
      throw new PathDoesNotExistError(input.path);
    }
    const realPath = await validatePath(input.path);
    const collectionName = resolveCollectionName(realPath);

    const existing = this.deps.registry.get(collectionName);
    const alreadyIndexed = existing !== null && existing.chunksCount > 0;

    if (existing === null) {
      this.deps.registry.record({
        collectionName,
        path: realPath,
        embeddingModel: "",
        embeddingDimensions: 0,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
    }
    try {
      this.deps.registry.setName(collectionName, input.name);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("not unique")) {
        const other = this.deps.registry.list().find((e) => e.name === input.name);
        throw new ProjectNameNotUniqueError(input.name, other?.collectionName ?? "");
      }
      throw err;
    }
    return { collectionName, alreadyIndexed };
  }

  async list(): Promise<{ projects: ProjectInfo[] }> {
    return { projects: this.deps.registry.list() };
  }

  async unregister(input: { name: string }): Promise<{ removed: boolean }> {
    const entry = this.deps.registry.findByName(input.name);
    if (!entry) return { removed: false };
    return { removed: this.deps.registry.remove(entry.collectionName) };
  }
}

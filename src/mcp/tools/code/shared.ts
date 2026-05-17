/**
 * Shared helpers for code-tool family modules.
 */

import { CollectionNotProvidedError, ProjectNotRegisteredError } from "../../../core/api/errors.js";
import type { App } from "../../../core/api/index.js";

/**
 * Resolve {path?, project?} → absolute path for indexing-pipeline tools whose
 * App methods only accept a path. When `project` is given but `path` is not,
 * look up the project alias via app.listProjects() (which reads CollectionRegistry).
 * Mirrors the priority `path > project` used elsewhere — but with no `collection`
 * support since these tools do not accept a collection name directly.
 */
export async function resolvePathFromProject(args: { path?: string; project?: string }, app: App): Promise<string> {
  if (args.path) return args.path;
  if (args.project) {
    const { projects } = await app.listProjects();
    const entry = projects.find((e) => e.name === args.project);
    if (!entry) {
      const available = projects.map((p) => p.name).filter((n): n is string => n !== null);
      throw new ProjectNotRegisteredError(args.project, available);
    }
    return entry.path;
  }
  throw new CollectionNotProvidedError();
}

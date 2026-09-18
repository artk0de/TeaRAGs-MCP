/**
 * ProjectIngestFactory — resolves the IngestFacade an index run must use, built
 * from the TARGET PROJECT's registry env rather than from the process env.
 *
 * The CLI applies a project's recorded env by seeding it into the environment
 * of the worker it forks per run. An MCP server has no such seam: it is
 * long-lived, its process env is fixed at spawn, and it serves many projects —
 * so a project indexed through `index_codebase` ran with whatever the server
 * happened to be started with, silently ignoring its own registered tuning
 * (tea-rags-mcp-pmfm4).
 *
 * This factory closes that gap at REQUEST scope. It never writes process.env:
 * the resolved env is merged into a private map and handed to `buildIngest`,
 * which parses a request-scoped config from it. Two projects indexing
 * concurrently therefore cannot clobber each other's environment — the only
 * shared state is a memo keyed by the resolved env itself.
 *
 * Replaying "under" the server env was only half of that fix: every key the
 * server env happened to set still beat the project's registry, so a server
 * spawned for one project re-chunked the others. In a server process a
 * project's own stamped index shape therefore outranks the spawn env, which
 * keeps winning for runtime tuning only (tea-rags-mcp-o0qsw).
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { IngestFacade } from "../core/api/index.js";
import {
  pickRegistryEntry,
  registryEnvGroupMembers,
  resolveRegistryEnv,
  type AmbientEnvRole,
  type RegistryLookup,
} from "../core/api/public/index.js";

export interface ProjectIngestFactoryDeps {
  /** Project registry the target path is looked up in. */
  registry: RegistryLookup;
  /**
   * Facade built from the process env — returned when the registry contributes
   * nothing beyond what the ambient env already sets. That is exactly the CLI
   * worker's situation (its env was seeded from the registry before the fork),
   * so the CLI keeps running on the single composition-root facade.
   */
  processIngest: IngestFacade;
  /** Builds an IngestFacade from a fully-resolved env map. */
  buildIngest: (env: Record<string, string>) => IngestFacade;
  /** Env this process was started with. Read only — never mutated. */
  ambientEnv?: NodeJS.ProcessEnv;
  /**
   * Where `ambientEnv` came from. `server` — a long-lived MCP server's spawn env,
   * every project's default — lets a project's own stamped index shape outrank
   * it (tea-rags-mcp-o0qsw). Defaults to `invocation`: the CLI worker's env was
   * seeded from the registry and then deliberately overridden by its shell.
   */
  ambientEnvRole?: AmbientEnvRole;
}

export class ProjectIngestFactory {
  /**
   * One facade per distinct resolved env, NOT per project: the facade owns the
   * run state a repeat index depends on (enrichment coordinator, its settle
   * promise, the stats-refresh hook), so a fresh one per request would strand
   * the previous run's background enrichment. Keying on the env rather than the
   * path also bounds the map by the number of distinct configurations, and
   * projects that share a configuration share a facade — which is exactly what
   * every project did before this factory existed.
   */
  private readonly byEnv = new Map<string, IngestFacade>();

  constructor(private readonly deps: ProjectIngestFactoryDeps) {}

  /** The IngestFacade an index run of `path` must use. */
  forPath(path: string): IngestFacade {
    const ambient = this.deps.ambientEnv ?? process.env;
    const target = normalizePath(path);
    // Only the project's OWN stamp outranks a server env. A borrowed seed (a new
    // project, a worktree of a known repo) records some other index's shape.
    const own = this.deps.registry.findByPath(target);
    const entry = own ?? pickRegistryEntry(this.deps.registry, { path: target });
    const overlay = resolveRegistryEnv(entry, ambient, own ? (this.deps.ambientEnvRole ?? "invocation") : "invocation");
    // Replay dropped every key the ambient env may override, so an empty
    // overlay means this project's recorded config IS the process config.
    if (Object.keys(overlay).length === 0) return this.deps.processIngest;

    const key = fingerprint(overlay);
    const cached = this.byEnv.get(key);
    if (cached) return cached;
    const built = this.deps.buildIngest(overlayOnto(ambient, overlay));
    this.byEnv.set(key, built);
    return built;
  }
}

/**
 * `overlay` merged over `ambient` by alias GROUP, not by key. A server-scoped
 * overlay can carry a group the ambient env also sets under another spelling
 * (a legacy `CODE_CHUNK_OVERLAP` stamp against a canonical
 * `INGEST_CHUNK_OVERLAP`), and the config parser prefers the canonical one, so
 * a key-level spread would let the ambient value win after all. For an
 * invocation overlay this is a no-op — replay never emits a group the ambient
 * env sets.
 */
function overlayOnto(ambient: NodeJS.ProcessEnv, overlay: Record<string, string>): Record<string, string> {
  const base = toStringMap(ambient);
  for (const key of Object.keys(overlay)) {
    for (const member of registryEnvGroupMembers(key)) delete base[member];
  }
  return { ...base, ...overlay };
}

/** Order-independent identity of an env overlay. */
function fingerprint(overlay: Record<string, string>): string {
  return JSON.stringify(Object.entries(overlay).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Normalize exactly as the indexing pipeline does before it records the entry
 * (`infra/collection-name.ts#validatePath` = realpath of the resolved path), so
 * a project addressed through a symlink, a relative path or a trailing slash
 * still finds ITS entry. A miss would fall through to "most recently indexed
 * project" and run this project under another project's tuning. Synchronous
 * because the lookup sits on the request path; an unreadable path degrades to
 * the resolved form, matching validatePath's own fallback.
 */
function normalizePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Drop undefined-valued keys so the merged map is a plain string record. */
function toStringMap(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Project Registry errors.
 *
 * These sat under `core/adapters/registry/` while the registry itself sat in
 * `core/infra/registry/`: the classes extend `InfraError` (an adapters class),
 * and infra may not import adapters, so the errors were parked one layer up
 * while their throwing sites stayed below — a split the file itself documented
 * as a KNOWN LAYERING CAVEAT.
 *
 * The registry is a maintenance-domain concern, and domains may import
 * adapters, so the split is gone: errors live next to the code that throws
 * them. See docs/superpowers/specs/2026-07-26-infra-tidy-design.md.
 */

import { InfraError } from "../../../adapters/errors.js";

/**
 * Thrown when registry.json cannot be parsed (invalid JSON, wrong version,
 * malformed shape). Non-fatal at load time — CollectionRegistry falls back to
 * an empty in-memory map.
 */
export class RegistryFileCorruptedError extends InfraError {
  constructor(path: string, reason: string) {
    super({
      code: "INFRA_REGISTRY_FILE_CORRUPTED",
      message: `Registry file at ${path} is corrupted: ${reason}`,
      hint: "Delete the file and re-run indexing, or run tea-rags doctor to regenerate from Qdrant.",
      httpStatus: 500,
    });
  }
}

/**
 * Thrown when an atomic write of registry.json fails (filesystem error).
 * Non-fatal for indexing — pipeline catches and logs.
 */
export class RegistryWriteError extends InfraError {
  constructor(path: string, cause: unknown) {
    super({
      code: "INFRA_REGISTRY_WRITE_FAILED",
      message: `Failed to write registry file at ${path}`,
      hint: "Check disk space and write permissions on the data directory.",
      httpStatus: 500,
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

/**
 * Thrown when the CAS retry loop in flush() exhausts its attempts because
 * another process keeps mutating registry.json. Indicates sustained
 * contention; the caller should log and move on (pipeline) or surface to
 * the user (interactive CLI).
 */
export class RegistryConcurrencyError extends InfraError {
  constructor(path: string, attempts: number) {
    super({
      code: "INFRA_REGISTRY_CONCURRENCY",
      message: `Registry file at ${path} was modified concurrently across ${attempts} attempts`,
      hint: "Retry the operation; if it persists, check for runaway tea-rags processes.",
      httpStatus: 503,
    });
  }
}

/** The registry facts an unresolvable-backend report quotes back to the operator. */
export interface RegistryQdrantBackendClaim {
  name: string | null;
  collectionName: string;
  qdrantUrl: string;
  teaRagsVersion?: string;
}

/**
 * Thrown when a registry entry's two records of its Qdrant backend contradict
 * each other and the release that wrote them is one whose pair cannot be
 * trusted (pre-1.34.0 stored `qdrantUrl` and `qdrantEmbedded` from independent
 * reads). Seeding either fact would silently point the run at the wrong
 * backend — most visibly at a frozen ephemeral port the embedded daemon
 * abandoned months ago, which surfaced as a bare "Qdrant is not reachable at
 * http://127.0.0.1:<dead>" with nothing in it the operator could act on.
 *
 * Re-registering rewrites the entry through the current write path, where both
 * fields come from one `isEmbedded` read and therefore always agree.
 */
export class RegistryQdrantBackendUnresolvedError extends InfraError {
  constructor(entry: RegistryQdrantBackendClaim) {
    const project = entry.name ?? entry.collectionName;
    const writer = entry.teaRagsVersion ?? "an unknown version";
    super({
      code: "INFRA_REGISTRY_QDRANT_BACKEND_UNRESOLVED",
      message:
        `Project '${project}' has a registry entry written by tea-rags ${writer} that is flagged embedded ` +
        `yet stores ${entry.qdrantUrl}, which is not an embedded-daemon address — the backend cannot be resolved`,
      hint:
        `Releases before 1.34.0 wrote qdrantUrl and qdrantEmbedded independently, so neither can be believed here. ` +
        `Re-register the project to rewrite the entry through the current path: ` +
        `tea-rags index-codebase --path <dir> --name ${project}`,
      httpStatus: 409,
    });
  }
}

/**
 * Thrown by CollectionRegistry.setName when the requested name is already
 * bound to a different collection. Infra-level defensive check — api callers
 * (ProjectRegistryOps.register) pre-validate via findByName and raise the
 * api-level InputValidationError first, so this only fires for direct registry
 * users that bypassed the api layer.
 */
export class RegistryNameConflictError extends InfraError {
  constructor(name: string, existingCollectionName: string) {
    super({
      code: "INFRA_REGISTRY_NAME_CONFLICT",
      message: `Project name '${name}' is not unique — already used by '${existingCollectionName}'`,
      hint: "Pre-validate via CollectionRegistry.findByName before calling setName, or surface this as a 409 to the user.",
      httpStatus: 409,
    });
  }
}

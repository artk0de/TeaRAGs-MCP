/**
 * Project Registry — adapter-layer errors.
 *
 * Lives under `core/adapters/registry/` because each class extends
 * `InfraError` (declared in `core/adapters/errors.ts`); keeping the file under
 * `core/infra/registry/` would force an `infra -> adapters` upward import
 * which `.claude/rules/domain-boundaries.md` forbids.
 *
 * KNOWN LAYERING CAVEAT: `core/infra/registry/registry-file.ts` and
 * `core/infra/registry/collection-registry.ts` still need to instantiate
 * these classes (they're the throwing sites), which means those infra
 * files import from this adapter file — the same upward direction the
 * relocation was meant to avoid.
 *
 * The relocation is therefore a partial fix that makes the directory
 * layout match the inheritance chain; the systemic resolution requires
 * relocating `InfraError` itself from `core/adapters/errors.ts` down to
 * `core/infra/errors.ts` (next to its sibling `TeaRagsError`). That move
 * touches the broader codebase (`embedding-model-guard.ts`,
 * `migration/adapters/*`, `collection-name.ts` already exhibit the same
 * `infra -> adapters`/`infra -> api` pattern) and is tracked separately
 * — see audit follow-up for "InfraError base class relocation".
 */

import { InfraError } from "../errors.js";

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

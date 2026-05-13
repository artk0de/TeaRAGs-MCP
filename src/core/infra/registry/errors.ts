/**
 * Project Registry — infrastructure errors.
 */

import { InfraError } from "../../adapters/errors.js";

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

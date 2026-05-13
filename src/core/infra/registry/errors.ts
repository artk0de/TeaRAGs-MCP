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

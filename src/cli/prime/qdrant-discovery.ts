import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_URL = "http://localhost:6333";

interface ConfigShape {
  qdrantUrl?: string;
}

/**
 * Resolve the Qdrant URL the same way the embedded daemon advertises itself.
 *
 * Order: QDRANT_URL env > config.qdrantUrl > <storagePath>/daemon.port > fallback.
 * Storage path mirrors getStoragePath in core/adapters/qdrant/embedded/daemon.ts
 * but the rule is duplicated here because CLI cannot import from core/adapters/
 * per the layer-boundary contract.
 */
export function discoverQdrantUrl(config: ConfigShape): string {
  if (process.env.QDRANT_URL) return process.env.QDRANT_URL;
  if (config.qdrantUrl) return config.qdrantUrl;

  const portFile = join(getStoragePath(), "daemon.port");
  if (!existsSync(portFile)) return FALLBACK_URL;

  try {
    const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
    if (!Number.isFinite(port) || port <= 0) return FALLBACK_URL;
    return `http://127.0.0.1:${port}`;
  } catch {
    return FALLBACK_URL;
  }
}

function getStoragePath(): string {
  if (process.env.QDRANT_EMBEDDED_STORAGE_PATH) {
    return process.env.QDRANT_EMBEDDED_STORAGE_PATH;
  }
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  return join(dataDir, "qdrant");
}

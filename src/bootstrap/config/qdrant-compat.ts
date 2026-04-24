import { QdrantVersionTooOldError } from "../../core/adapters/qdrant/errors.js";
import { compareSemver, isSemver, QDRANT_VERSION } from "../../core/infra/qdrant-version.js";

/**
 * Validate that an externally-managed Qdrant server meets the version
 * declared in `.qdrant-required-version`.
 *
 * Throws {@link QdrantVersionTooOldError} only when the server successfully
 * reports a semver string strictly older than {@link QDRANT_VERSION}. All
 * other conditions (connection error, non-OK HTTP, missing/malformed
 * version field) are treated as "skip" — the subsequent QdrantManager
 * health handling owns reachability, and we do not want to fail startup
 * against proxies or non-standard Qdrant-compatible servers that omit the
 * field.
 *
 * Embedded daemons MUST NOT be passed through this function — their
 * version is pinned by {@link QDRANT_VERSION} directly.
 */
export async function checkExternalQdrantVersion(url: string, apiKey?: string): Promise<void> {
  let body: unknown;
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["api-key"] = apiKey;
    const res = await fetch(`${url}/`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    body = await res.json();
  } catch {
    return;
  }
  const raw = (body as { version?: unknown } | null)?.version;
  if (typeof raw !== "string") return;
  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!isSemver(normalized)) return;
  if (compareSemver(normalized, QDRANT_VERSION) < 0) {
    throw new QdrantVersionTooOldError(url, normalized, QDRANT_VERSION);
  }
}

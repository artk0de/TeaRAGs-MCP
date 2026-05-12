/**
 * Discriminated union describing the result of a package-version check.
 *
 * `unavailable` is NOT an error — it is a valid domain state meaning "we
 * could not determine status this time". Callers render it (or skip it)
 * accordingly; they never need a try/catch around the service call.
 */
export type UpdateStatus =
  | { kind: "available"; current: string; latest: string; changelogUrl: string }
  | { kind: "up-to-date"; current: string }
  | { kind: "unavailable"; reason: UnavailableReason };

export type UnavailableReason = "network" | "timeout" | "malformed" | "cache-miss";

/** Cached on-disk envelope around UpdateStatus. */
export interface CacheEntry {
  status: UpdateStatus;
  fetchedAt: number; // epoch ms
  ttlMs: number; // 86_400_000 positive / 300_000 negative
}

/** Options consumed by UpdateCheckService.checkForUpdate. */
export interface CheckOptions {
  allowNetwork: boolean;
  timeoutMs?: number;
  preferCache: boolean;
}

/** GitHub release URL for a given tea-rags version tag. */
export function buildChangelogUrl(version: string): string {
  return `https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v${version}`;
}

export function available(current: string, latest: string): UpdateStatus {
  return {
    kind: "available",
    current,
    latest,
    changelogUrl: buildChangelogUrl(latest),
  };
}

export function upToDate(current: string): UpdateStatus {
  return { kind: "up-to-date", current };
}

export function unavailable(reason: UnavailableReason): UpdateStatus {
  return { kind: "unavailable", reason };
}

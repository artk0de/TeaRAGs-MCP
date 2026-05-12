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
  readonly status: UpdateStatus;
  readonly fetchedAt: number;
  readonly ttlMs: number;
}

/** Options consumed by UpdateCheckService.checkForUpdate. */
export interface CheckOptions {
  readonly allowNetwork: boolean;
  readonly timeoutMs?: number;
  readonly preferCache: boolean;
}

// Duplicated intentionally — Task 2 introduces semver.ts and dedupes.
// Keeping inline here keeps Task 1 independent of Task 2.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** GitHub release URL for a given tea-rags version tag. */
export function buildChangelogUrl(version: string): string {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`buildChangelogUrl: expected X.Y.Z semver, got: ${version}`);
  }
  return `https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v${version}`;
}

export function available(current: string, latest: string): UpdateStatus {
  if (!SEMVER_RE.test(current)) {
    throw new Error(`available: expected X.Y.Z semver for current, got: ${current}`);
  }
  // buildChangelogUrl validates `latest` for us.
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

/**
 * Canary window for the background client update (bd tea-rags-mcp-c2dr6): a
 * release becomes installable only once it has been public long enough for a
 * broken publish to be noticed and superseded — 3 days for a minor/patch bump,
 * 7 days for a major one. Manual `tea-rags update` does not apply it.
 */

import type { NpmReleaseTimeline } from "../update-check/registry-client.js";
import { compareSemver, isValidSemver } from "../update-check/semver.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CANARY_MIN_AGE_MS = { minorOrPatch: 3 * DAY_MS, major: 7 * DAY_MS } as const;

/**
 * The newest release above `current` (and not above `latest`) whose publish
 * time has passed its canary window, or null when none has.
 */
export function selectCanaryRelease(current: string, timeline: NpmReleaseTimeline, now: number): string | null {
  if (!isValidSemver(current) || !isValidSemver(timeline.latest)) return null;
  let chosen: string | null = null;
  for (const [version, publishedAt] of Object.entries(timeline.publishedAt)) {
    if (!isValidSemver(version)) continue;
    if (compareSemver(version, current) <= 0 || compareSemver(version, timeline.latest) > 0) continue;
    const publishedMs = Date.parse(publishedAt);
    if (Number.isNaN(publishedMs) || now - publishedMs < minimumAge(current, version)) continue;
    if (chosen === null || compareSemver(version, chosen) > 0) chosen = version;
  }
  return chosen;
}

function minimumAge(current: string, candidate: string): number {
  return majorOf(candidate) > majorOf(current) ? CANARY_MIN_AGE_MS.major : CANARY_MIN_AGE_MS.minorOrPatch;
}

function majorOf(version: string): number {
  return parseInt(version.split(".")[0], 10);
}

import type { UpdateStatus } from "./types.js";

/** Plain text for `tea-rags update` stdout / stderr. */
export function formatForCli(status: UpdateStatus): string {
  switch (status.kind) {
    case "available":
      return [`tea-rags ${status.current} → ${status.latest} available.`, `changelog: ${status.changelogUrl}`].join(
        "\n",
      );
    case "up-to-date":
      return `tea-rags ${status.current} is up to date.`;
    case "unavailable":
      return `Couldn't check for updates (reason: ${status.reason}). Try again later.`;
  }
}

/**
 * Markdown lines for the prime digest. Returns an empty array unless the
 * status is "available" — `up-to-date` and `unavailable` are intentionally
 * omitted from the digest to avoid noise.
 */
export function formatForPrime(status: UpdateStatus): string[] {
  if (status.kind !== "available") return [];
  return [
    "## tea-rags package",
    `current:   ${status.current}`,
    `available: ${status.latest}`,
    `changelog: ${status.changelogUrl}`,
    "",
    "→ run `tea-rags update` to upgrade",
  ];
}

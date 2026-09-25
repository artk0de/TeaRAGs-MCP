import type { Colorizer } from "../infra/color.js";
import type { UpdateStatus } from "./types.js";

/**
 * Text for `tea-rags update` stdout / stderr. Coloring goes through the injected
 * {@link Colorizer}, so the text is byte-identical with color off.
 */
export function formatForCli(status: UpdateStatus, c: Colorizer): string {
  switch (status.kind) {
    case "available":
      return [
        `tea-rags ${status.current} → ${c.bold(c.ok(status.latest))} available.`,
        `${c.dim("changelog:")} ${c.brand(status.changelogUrl)}`,
      ].join("\n");
    case "up-to-date":
      return c.ok(`tea-rags ${status.current} is up to date.`);
    case "unavailable":
      return c.warn(`Couldn't check for updates (reason: ${status.reason}). Try again later.`);
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

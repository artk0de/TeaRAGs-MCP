/**
 * Pure formatting helpers for the lines `tea-rags tune` prints itself — the
 * benchmark scripts it spawns render their own report.
 *
 * Coloring goes through an injected {@link Colorizer}, so the text is identical
 * with color off and tests assert on plain text.
 */

import type { Colorizer } from "../infra/color.js";

const TAG = "[tea-rags]";

/** A successful full tune merged its measured env into the project's registry snapshot. */
export function formatTuneRegistryUpdate(project: string, applied: number, c: Colorizer): string {
  return `${c.dim(TAG)} ${c.ok("registry env snapshot updated")} for '${project}' (${applied} measured keys)`;
}

/** The tune run succeeded but the registry write after it did not. */
export function formatTuneRegistryWriteFailure(reason: string, c: Colorizer): string {
  return `${c.dim(TAG)} ${c.alert(`tune registry write failed: ${reason}`)}`;
}

/** An argument the user can fix, with the hint telling them how. */
export function formatTuneInputError(message: string, hint: string, c: Colorizer): string {
  return `${c.alert(message)}\n${c.dim("Hint:")} ${hint}`;
}

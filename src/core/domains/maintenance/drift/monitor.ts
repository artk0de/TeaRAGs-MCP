/**
 * The contract every index-drift axis implements.
 *
 * A monitor answers ONE question about ONE collection — did the payload keys
 * move, did a language's tooling move, did the indexing env move, did the
 * working tree move — and hands back findings, not prose. Rendering and the
 * "already warned" bookkeeping belong to `IndexDriftReporter`, so a new axis is
 * a new monitor and nothing else changes.
 */

import type { IndexDriftRemedy } from "./remedy.js";

export type IndexDriftAxis = "payloadKeys" | "statsContract" | "languageVersions" | "env" | "commit";

export interface IndexDriftFinding {
  axis: IndexDriftAxis;
  /** payload key | signal key | `<language>.<axis>` | env key | branch */
  subject: string;
  indexed: string;
  current: string;
  remedy: IndexDriftRemedy;
  note?: string;
}

export interface IndexDriftMonitor {
  readonly axis: IndexDriftAxis;
  check: (collectionName: string) => IndexDriftFinding[];
}

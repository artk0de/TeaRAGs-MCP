/**
 * The one human wording of how the Rust rustc call-site driver settled for an
 * index run (research/rustc-driver/SPEC.md §8.3, bd s3i8m T9), rendered by the
 * MCP `index_codebase` / `get_index_status` responses, the CLI status block and
 * `prime` — the same single-wording split `formatWorktreeSeedReport` makes, so
 * the surfaces cannot describe one outcome two ways.
 *
 * The driver is ON by default, so the line says what it cost the user: `cargo
 * check` executed build scripts and proc macros. Every field past `outcome` is
 * optional — the line renders what the run reported and omits the rest.
 */

/** How the driver settled; `unavailable` and `off` are the two "never ran" verdicts. */
export interface RustcDriverStatus {
  outcome: "indexed" | "latched" | "skipped" | "unavailable" | "off";
  /** `latched` / `skipped`: why. */
  reason?: string;
  /** `latched`: what failed. */
  detail?: string;
  /** What the user can do: the install hint for `unavailable`, a fetch hint for a latch. */
  hint?: string;
  /** `indexed`: the index was reused from the per-envKey cache, so no `cargo check` ran. */
  cacheHit?: boolean;
  wallMs?: number;
  /** `indexed`: unit files the index was decoded from. */
  units?: number;
  /** `indexed`: crate targets that failed to compile under the pin. */
  failedCrates?: readonly string[];
}

/**
 * The status as the codegraph run persisted it (bd s3i8m): written by the
 * enrichment worker's finalize, read later by status and prime. `recordedAtMs`
 * tells an index run whether the record is its own or an earlier run's.
 */
export interface RustcDriverStatusRecord {
  status: RustcDriverStatus;
  recordedAtMs: number;
}

/**
 * The driver status of one codegraph pass, read off the per-language resolver
 * report (`CallEdgeResolutionRunner#resolverDiagnostics`): the Rust resolver's
 * `rustcCallSites` acquisition. Absent when no Rust pass reported one. The
 * switched-off and toolchain-less skips are the two "never ran" verdicts the
 * line renders apart from an ordinary skip.
 */
export function rustcDriverStatusOf(
  resolvers: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): RustcDriverStatus | undefined {
  const acquisition = resolvers.rust?.rustcCallSites;
  if (typeof acquisition !== "object" || acquisition === null) return undefined;
  const reported = acquisition as Record<string, unknown>;
  const reason = stringField(reported, "reason");
  const hint = stringField(reported, "hint");
  switch (reported.outcome) {
    case "indexed":
      return {
        outcome: "indexed",
        ...definedFields({
          cacheHit: typeof reported.cacheHit === "boolean" ? reported.cacheHit : undefined,
          wallMs: numberField(reported, "wallMs"),
          units: numberField(reported, "units"),
          failedCrates: Array.isArray(reported.failedCrates) ? (reported.failedCrates as string[]) : undefined,
        }),
      };
    case "latched":
      return { outcome: "latched", ...definedFields({ reason, detail: stringField(reported, "detail"), hint }) };
    case "skipped":
      if (reason === "disabled") return { outcome: "off" };
      if (reason === "unavailable") return { outcome: "unavailable", ...definedFields({ hint }) };
      return { outcome: "skipped", ...definedFields({ reason, hint }) };
    default:
      return undefined;
  }
}

function stringField(reported: Record<string, unknown>, key: string): string | undefined {
  const value = reported[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(reported: Record<string, unknown>, key: string): number | undefined {
  const value = reported[key];
  return typeof value === "number" ? value : undefined;
}

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

const SUBJECT = "rustc driver:";
const HINT_SUBJECT_PREFIX = "rustc call-site driver unavailable — ";
const FAILED_NAMES_SHOWN = 3;

export function formatRustcDriverLine(status: RustcDriverStatus): string {
  switch (status.outcome) {
    case "indexed":
      return indexedLine(status);
    case "latched":
      return latchedLine(status);
    case "skipped":
      return `${SUBJECT} skipped — ${status.reason ?? "no reason reported"}`;
    case "unavailable":
      return `${SUBJECT} unavailable — ${installAdvice(status.hint)}`;
    case "off":
      return `${SUBJECT} off (CODEGRAPH_RUST_DRIVER=off)`;
  }
}

function indexedLine(status: RustcDriverStatus): string {
  const what = status.cacheHit ? "cache hit, cargo check not re-run" : "cargo check ran build scripts and proc macros";
  const parts = [`${SUBJECT} indexed (${what})`];
  if (status.units !== undefined) parts.push(`units ${status.units}`);
  const failed = status.failedCrates ?? [];
  if (failed.length > 0) parts.push(`failed ${failed.length} (${failedNames(failed)})`);
  if (status.wallMs !== undefined) parts.push(`${Math.round(status.wallMs / 1000)} s`);
  return parts.join(" · ");
}

function failedNames(failed: readonly string[]): string {
  const shown = failed.slice(0, FAILED_NAMES_SHOWN).join(", ");
  const rest = failed.length - FAILED_NAMES_SHOWN;
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

function latchedLine(status: RustcDriverStatus): string {
  const reason = status.reason ?? "no reason reported";
  const detail = status.detail === undefined ? "" : ` (${status.detail})`;
  const hint = status.hint === undefined ? "" : ` — ${status.hint}`;
  return `${SUBJECT} latched — ${reason}${detail}${hint}`;
}

/** The adapter's hint opens by restating the subject the line already carries. */
function installAdvice(hint: string | undefined): string {
  if (hint === undefined) return "no toolchain found";
  return hint.startsWith(HINT_SUBJECT_PREFIX) ? hint.slice(HINT_SUBJECT_PREFIX.length) : hint;
}

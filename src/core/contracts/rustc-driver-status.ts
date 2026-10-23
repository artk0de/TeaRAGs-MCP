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

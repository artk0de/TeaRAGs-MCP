/**
 * Python's dispatch fan-out policy values (bd tea-rags-mcp-w205u, E4.1
 * decision 2) — the cap the untyped-name fan is allowed to reach, and the
 * confidence a fanned edge carries.
 */

import type { DispatchFanoutPopulation } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import { isPythonSourcePath } from "../../vocabulary/source-extensions.js";

/**
 * The population the corpus-adaptive ceiling is computed over (bd
 * tea-rags-mcp-nbf8q): the Python files `lookupPythonSymbolsByShortName` draws
 * candidates from, so a polyglot repo's other half no longer sets Python's
 * ceiling. Inert on output today — the ceiling is floored at 16 and
 * {@link PY_DISPATCH_FAN_MAX} (4) is always the tighter of the two — but it
 * keeps the ceiling honest if the Python cap is ever lifted past the floor.
 */
export const PYTHON_FANOUT_POPULATION: DispatchFanoutPopulation = {
  family: "python",
  ownsPath: isPythonSourcePath,
  calleeKinds: capability.codegraph.symbolKindRoles.callee,
};

/**
 * Python's dispatch fan cap.
 *
 * The corpus-adaptive policy (`dispatchFanoutPolicyFor`) reads 16 on all five
 * measurement corpora — its floor, since p99 defs-per-member is 5–11. At 16 the
 * untyped-name fan measures recall 118/122 at p95 ELEVEN, which fails E4.1's
 * p95 ≤ 4 bar; at 4 it measures 61/62 at p95 4, and 96 rows become `ambiguous`
 * instead. So Python asks for a tighter cap and the corpus-adaptive one stays
 * the CEILING — `resolveNarrowedFanout` mins the two, so a corpus whose p99
 * justified something smaller keeps the smaller number.
 */
export const PY_DISPATCH_FAN_MAX = 4;

/**
 * Confidence a fan of m carries: `PY_DYNAMIC_RECEIVER_CONFIDENCE / m`, which
 * keeps every fanned edge under the navigation-visible floor. Deliberately
 * Python's OWN knob rather than an import of Ruby's constant of the same value:
 * the two languages' fans answer different populations and re-measuring one
 * must never move the other.
 */
export const PY_DYNAMIC_RECEIVER_CONFIDENCE = 0.5;

/**
 * The cap this process asks for, read ONCE at composition from
 * `CODEGRAPH_PY_DISPATCH_FAN_MAX` — the re-measure knob for the cap sweep.
 * Absent, non-integer or non-positive ⇒ the measured default. Reading it per
 * call would put a `process.env` lookup on the hot path of every untyped call
 * site in the corpus.
 */
export function resolvePythonDispatchFanMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : PY_DISPATCH_FAN_MAX;
}

/**
 * Is the untyped-name fan composed at all? Read ONCE at composition from
 * `CODEGRAPH_PY_DYNAMIC_DISPATCH`; **default ON** since bd
 * tea-rags-mcp-m99j1.1.57.
 *
 * It was parked OFF first (bd tea-rags-mcp-w205u, D10): a name-only fan booked
 * +83 new 1:1 matches against +85 fabricated edges over five corpora, because
 * the surplus receivers held a LIBRARY type with a coincidental single project
 * owner of the member. The decline gates in `pythonDynamicFanoutSuppressed`
 * closed that gap one evidence channel at a time — typeshed members, typed and
 * foreign-call bindings, and last the walker's `assignedLocals`, which declines
 * a local assigned from an expression nothing types. The flip measurement
 * (`--tiebreak`) is on the bead and in the Python navigator.
 *
 * `0` / `false` / `off` / `no` turn it off — the re-measure baseline;
 * everything else, absent included, composes it.
 */
export function pythonDynamicDispatchEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

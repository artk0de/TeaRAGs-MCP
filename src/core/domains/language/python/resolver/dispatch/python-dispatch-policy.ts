/**
 * Python's dispatch fan-out policy values (bd tea-rags-mcp-w205u, E4.1
 * decision 2) — the cap the untyped-name fan is allowed to reach, and the
 * confidence a fanned edge carries.
 */

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
 * `CODEGRAPH_PY_DYNAMIC_DISPATCH`; **default OFF** (bd tea-rags-mcp-w205u, D10).
 *
 * A name-only fan is not precision-safe for Python without receiver-type
 * evidence. Measured over five corpora it books +83 new 1:1 matches against +85
 * new fabricated edges and `recall@fan` 0.344 on polar, because it fires on ~5×
 * the sites E4.0.4 attributed and the surplus is receivers whose real type is a
 * LIBRARY type with a coincidental single project owner of the member. The
 * component, its probe, its gates and its tests stay — what is parked is the
 * COMPOSITION, so a re-attempt with a type channel behind it is a flag flip and
 * a re-measure rather than an archaeology exercise.
 *
 * `1` / `true` / `on` / `yes` turn it on; everything else, absent included,
 * leaves `resolveDispatch` exactly the cone it was before E4.1.3.
 */
export function pythonDynamicDispatchEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

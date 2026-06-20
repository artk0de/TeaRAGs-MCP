/**
 * Per-idiom receiver-kind classifier for resolve instrumentation
 * (bd tea-rags-mcp-j431). Pure, language-agnostic, cheap: classifies a call's
 * receiver from the CallRef text + the chunk's localBindings WITHOUT running the
 * resolver. The codegraph provider tallies attempted/resolved per kind so each
 * cai0 slice (2jet cone, duzy DSL, wbj3 dynamic, 9zlt registry) proves a delta
 * on the exact bucket it targets instead of moving one aggregate number.
 *
 * Boundary note: trajectory must not import the language domain
 * (domain-boundaries.md). The per-language `super` sentinels are matched as
 * literals here — TS emits receiver `"super"`, the Ruby walker emits
 * `SUPER_RECEIVER_SENTINEL` (`"<super>"`). These are stable markers; the
 * classifier is a heuristic instrument, not a contract participant.
 */
import type { CallRef, LocalBinding } from "../../../../contracts/types/codegraph.js";

export type ReceiverKind = "constant" | "localVar" | "selfMember" | "super" | "bareCall" | "dynamic";

export const RECEIVER_KINDS: readonly ReceiverKind[] = [
  "constant",
  "localVar",
  "selfMember",
  "super",
  "bareCall",
  "dynamic",
] as const;

const SUPER_MARKERS = new Set(["super", "<super>"]);
const CONST_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * Classify the receiver idiom of a call. `localBindings` maps in-scope variable
 * names to their inferred type (the chunk's `localBindings`); a receiver present
 * there is a typed local. Precedence: bare → super → self → typed-local →
 * constant → dynamic (unbound non-constant receiver: arr.map, obj[k], chains).
 */
export function classifyReceiverKind(
  call: CallRef,
  localBindings: Record<string, LocalBinding[]> | undefined,
): ReceiverKind {
  const r = call.receiver;
  if (r === null) return "bareCall";
  if (SUPER_MARKERS.has(r)) return "super";
  if (r === "self") return "selfMember";
  if (localBindings && Object.prototype.hasOwnProperty.call(localBindings, r)) return "localVar";
  if (CONST_RE.test(r)) return "constant";
  return "dynamic";
}

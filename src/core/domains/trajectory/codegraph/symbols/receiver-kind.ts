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
 *
 * The `super` markers alone are the exception: {@link isSuperReceiver} is also
 * read by the self-dispatch discovery (a `super`-delegating override inherits
 * its ancestor template's hook), so a walker renaming its sentinel breaks
 * resolution, not just instrumentation.
 */
import type { CallRef, LocalBinding } from "../../../../contracts/types/codegraph.js";

export type ReceiverKind =
  | "constant"
  | "localVar"
  | "selfMember"
  | "super"
  | "bareCall"
  | "ivar"
  | "chain"
  | "index"
  | "dynamic";

export const RECEIVER_KINDS: readonly ReceiverKind[] = [
  "constant",
  "localVar",
  "selfMember",
  "super",
  "bareCall",
  "ivar",
  "chain",
  "index",
  "dynamic",
] as const;

const SUPER_MARKERS = new Set(["super", "<super>"]);

/** Whether a call's receiver is a language's `super` marker. */
export function isSuperReceiver(receiver: string | null): boolean {
  return receiver !== null && SUPER_MARKERS.has(receiver);
}

const CONST_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * Classify the receiver idiom of a call. `localBindings` maps in-scope variable
 * names to their inferred type (the chunk's `localBindings`); a receiver present
 * there is a typed local. Precedence: bare → super → self → typed-local →
 * constant → (residual unbound non-constant receiver, sub-classified below).
 *
 * The residual bucket — what used to be a single `dynamic` lump — is split by
 * heuristic source markers in the raw receiver text (`receiver.text`), with this
 * precedence:
 *   1. `[` present  → `index`   (element-reference receiver `obj[k]`)
 *   2. `.` present  → `chain`   (method-chain receiver `a.b`, `@x.y`, safe-nav `a&.b`)
 *   3. starts `@`   → `ivar`    (Ruby instance/class variable `@foo` / `@@foo`)
 *   4. else         → `dynamic` (true-dynamic: unbound bare identifier / method result)
 *
 * Decomposition example: `@account.posts.first` — the OUTER call's receiver is
 * `@account.posts` (has `.`) → `chain`; the INNER call's receiver is `@account`
 * (no `.`/`[`, starts `@`) → `ivar` (the Rails-dense case). `@`/`[`/`.` are
 * heuristic source markers — same spirit as the `SUPER_MARKERS` literals above:
 * the classifier is an instrument, not a contract participant.
 */
export function classifyReceiverKind(
  call: CallRef,
  localBindings: Record<string, LocalBinding[]> | undefined,
): ReceiverKind {
  const r = call.receiver;
  if (r === null) return "bareCall";
  if (isSuperReceiver(r)) return "super";
  if (r === "self") return "selfMember";
  if (localBindings && Object.prototype.hasOwnProperty.call(localBindings, r)) return "localVar";
  if (CONST_RE.test(r)) return "constant";
  if (r.includes("[")) return "index";
  if (r.includes(".")) return "chain";
  if (r.startsWith("@")) return "ivar";
  return "dynamic";
}

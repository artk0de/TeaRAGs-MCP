import {
  nearestCallResultBinding,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import { PYTHON_BUILTINS } from "../../vocabulary/builtins.js";
import {
  findPythonImportBinding,
  lookupPythonSymbolsByShortName,
  pythonBoundToForeignCall,
} from "../strategies/shared.js";
import type { PythonChainAnswerProbe } from "./python-chain-probe.js";

/**
 * A receiver whose first LETTER is upper-case is a class object or a module
 * constant, not a value the fan may dispatch on: `Repo`, `HTTPClient`, and —
 * because a leading underscore is a privacy convention and not part of the
 * name's case — `_TELEGRAM_RE`, a compiled `re.Pattern` that fanned onto
 * `DistrictMatcher#match` on ugnest.
 */
const PYTHON_CLASS_HEAD = /^_*[A-Z]/;

/**
 * A receiver bound to a call the project cannot type, in either of the two
 * shapes that carry no usable evidence.
 *
 * The shared {@link pythonBoundToForeignCall} answers the first: the callee's
 * HEAD is a name the project does not declare (`logging.getLogger(…)`,
 * `authenticate(…)`). It deliberately exempts a `self.` / `cls.` head, because
 * the strategy it was measured for guesses a class from the receiver's SPELLING
 * and `self.build_thing()` is the caller's own object.
 *
 * The fan asks a different question and needs the second shape too. For a
 * `self.` head the informative segment is the MEMBER, not the head:
 * `serializer = self.get_serializer(data=…)` binds a value whose type is
 * decided by a library base class, and no project file declares
 * `get_serializer` at all. Fanning it produced ugnest's canonical false
 * positive — `serializer.is_valid()` attributed to `ConfirmationCode`, the very
 * row `python-local-binding.ts`'s terminal DROP exists to stop.
 */
function pythonBoundToUntypeableCall(receiver: string, atLine: number, ctx: CallContext): boolean {
  if (pythonBoundToForeignCall(receiver, atLine, ctx)) return true;
  const binding = nearestCallResultBinding(ctx.callResultBindings, receiver, atLine);
  if (binding === undefined) return false;
  const segments = binding.callee.split(".");
  if (segments[0] !== "self" && segments[0] !== "cls") return false;
  const member = segments[segments.length - 1];
  return member.length > 0 && lookupPythonSymbolsByShortName(ctx, member).length === 0;
}

/**
 * Every receiver shape the untyped-name fan must NOT touch (bd
 * tea-rags-mcp-w205u, E4.1.3) — Ruby's `rubyDynamicFanoutSuppressed` in Python
 * spelling.
 *
 * The component is LAST and its edges REPLACE whatever the chain would have
 * said, so the gate is what keeps the runner's dispatch-first path honest: a
 * shape another layer owns must reach that layer untouched, and an exact answer
 * must never be buried under N discounted ones.
 *
 * ORDER IS THE BEHAVIOUR, cheapest first. The receiver-shape tests are string
 * work; the binding lookups read one record; `coreAmbiguous` consults the
 * external vocabulary; the chain probe is the only expensive one and runs last
 * (memoised, so the resolver's own `resolve` reuses its answer).
 *
 * What each gate hands back, and to whom:
 *  - bare call / `self` / `cls` — the bare-call and self paths (E4.6b);
 *  - dotted receiver — the field hop and module-alias paths (E4.6a, E4.6c);
 *  - a call or index head — the chain-head and element hops (E4.6b, E4.5);
 *  - a capitalised receiver, `_LEADING_UNDERSCORE` included — the constant path;
 *  - a receiver spelled like a BUILTIN — the interpreter's, never a project
 *    value. `super` is one (the walker files a zero-argument `super()` as the
 *    bare text `super`, and the `super` pass DROPs rather than answering, so
 *    the probe cannot speak for it), and so are `int`, `str` and `type`
 *    (`int.__new__(cls, value)` is a core constructor, not a project member);
 *  - a receiver the walker BOUND at this line — the `localBinding` pass, whose
 *    terminal DROP is what stopped `serializer.is_valid()` resolving to
 *    `ConfirmationCode`; re-opening it is a different bead;
 *  - an imported name — the `importedName` pass;
 *  - a receiver bound to a call the project cannot type — a foreign head
 *    (`logger = logging.getLogger(…)`) or a `self.<member>` no project file
 *    declares (`serializer = self.get_serializer(…)`);
 *  - a `dict`/`list`/`str` runtime member on an untyped receiver, and a member
 *    the interpreter itself owns — nothing in project, by construction;
 *  - anything the chain answers — the chain.
 */
export function pythonDynamicFanoutSuppressed(
  call: CallRef,
  ctx: CallContext,
  probe: PythonChainAnswerProbe,
  coreAmbiguous: (call: CallRef, ctx: CallContext) => boolean,
): boolean {
  const { receiver } = call;
  if (receiver === null || receiver.length === 0) return true;
  if (receiver === "self" || receiver === "cls") return true;
  if (receiver.includes(".")) return true;
  if (receiver.endsWith(")") || receiver.endsWith("]")) return true;
  if (PYTHON_CLASS_HEAD.test(receiver)) return true;
  if (PYTHON_BUILTINS.has(receiver)) return true;
  if (resolveLocalBinding(ctx.localBindings, receiver, call.startLine) !== undefined) return true;
  if (findPythonImportBinding(ctx.imports, receiver) !== null) return true;
  if (pythonBoundToUntypeableCall(receiver, call.startLine, ctx)) return true;
  if (coreAmbiguous(call, ctx)) return true;
  if (PYTHON_BUILTINS.has(call.member)) return true;
  return probe.answers(call, ctx);
}

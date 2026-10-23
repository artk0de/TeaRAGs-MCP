import { createIdentifierRecord, identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, CallRef, CallResultBinding, LocalBinding } from "../../../../contracts/types/codegraph.js";
import { projectDeclaresType, rustStdTypeRef } from "./std-type-hops.js";
import { rustShadowingCallResultType } from "./strategies/rust-type-receiver.js";
import { rustVisibleReceiverBinding } from "./visible-receiver-binding.js";

const RUST_RECEIVER_HEAD = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * The walker's inferred binding shapes (`inferenceShape`: an enum variant
 * constructor, agreeing `if` / `match` arms, a `*self` copy, a call-result
 * `let` kept through reassignment) are ADDITIVE over the read the call had
 * before they existed (src/core/domains/language/CLAUDE.md). The views below
 * are taken per call, for its receiver head; a call whose head carries no
 * shaped binding gets the same `ctx` object back from each.
 */
function rustReceiverHead(call: CallRef): string | undefined {
  const head = call.receiver === null ? undefined : RUST_RECEIVER_HEAD.exec(call.receiver)?.[0];
  return head === "self" ? undefined : head;
}

/** The head has a shaped local binding — the resolve pass then falls back to the pre-shape read on a miss. */
export function rustHeadHasInferredLocal(call: CallRef, ctx: CallContext): boolean {
  const head = rustReceiverHead(call);
  if (head === undefined) return false;
  return identifierEntry(ctx.localBindings, head)?.some(isShaped) === true;
}

/**
 * The pre-shape read: every shaped local and shaped call-result `let` of the
 * head dropped — before the shapes the walker wrote none of them (it declined
 * a reassigned or arms-initialized name outright).
 */
export function rustWithoutInferredBindings(call: CallRef, ctx: CallContext): CallContext {
  const head = rustReceiverHead(call);
  if (head === undefined) return ctx;
  const localEntries = identifierEntry(ctx.localBindings, head);
  const callResultEntries = identifierEntry(ctx.callResultBindings, head);
  let view = ctx;
  if (localEntries?.some(isShaped) === true) {
    view = { ...view, localBindings: withEntry(view.localBindings, head, localEntries.filter(isUnshaped)) };
  }
  if (callResultEntries?.some(isShaped) === true) {
    view = {
      ...view,
      callResultBindings: withEntry(view.callResultBindings, head, callResultEntries.filter(isUnshaped)),
    };
  }
  return view;
}

/**
 * Every shaped call-result `let` of the head — and every shaped local of it —
 * read as absent when the `let` visible at the call types to nothing: the
 * walker declined such a name before, so the call reads the binding beneath it
 * (a parameter, an earlier local) exactly as then, never the global namesake
 * an untyped receiver falls to (`let mut rect = rect.to_webrender(); rect = rect.inflate(..)`
 * over an associated-type return). A `let` the same line's local types (the
 * `constructor` channel) stays typed.
 */
export function rustWithTypableInferredLets(call: CallRef, ctx: CallContext): CallContext {
  const head = rustReceiverHead(call);
  if (head === undefined) return ctx;
  const callResultEntries = identifierEntry(ctx.callResultBindings, head);
  if (callResultEntries?.some(isShaped) !== true) return ctx;
  const visible = rustVisibleReceiverBinding(head, call.startLine, ctx, call.startColumn);
  if (
    visible?.channel !== "callResult" ||
    visible.binding.inferenceShape === undefined ||
    rustShadowingCallResultType(head, call.startLine, ctx, visible.binding) !== undefined
  ) {
    return ctx;
  }
  return rustWithoutInferredBindings(call, ctx);
}

/**
 * The view for every pass that does not resolve (dispatch fan-out, the miss
 * classifier): `rustWithTypableInferredLets`, and a shaped local whose type
 * places neither as a std type nor as a type the project declares —
 * `TiInstant::Monotonic(..)` under a `use .. as` rename, `*self` in
 * `impl .. for DateTime` over a re-exported alias — read as absent.
 */
export function rustWithAdditiveInferredBindings(call: CallRef, ctx: CallContext): CallContext {
  const view = rustWithTypableInferredLets(call, ctx);
  const head = rustReceiverHead(call);
  if (head === undefined) return view;
  const localEntries = identifierEntry(view.localBindings, head);
  if (localEntries?.some(isShaped) !== true) return view;
  const kept = localEntries.filter(
    (binding) => binding.inferenceShape === undefined || rustLocalTypePlaces(binding, view),
  );
  return kept.length === localEntries.length
    ? view
    : { ...view, localBindings: withEntry(view.localBindings, head, kept) };
}

function isShaped(binding: LocalBinding | CallResultBinding): boolean {
  return binding.inferenceShape !== undefined;
}

function isUnshaped(binding: LocalBinding | CallResultBinding): boolean {
  return binding.inferenceShape === undefined;
}

/**
 * The shaped local's type places: a std type, or a name the project declares
 * a type by — its OWN declaration, not only an `impl` block reopening the name
 * (`impl .. for DateTime` over a re-exported `Time as DateTime`). The member
 * lookup reads the binding by that short name, so the short name is the test.
 */
function rustLocalTypePlaces(binding: LocalBinding, ctx: CallContext): boolean {
  if (binding.type.length === 0) return false;
  if (rustStdTypeRef(binding.type, undefined, ctx) !== undefined) return true;
  const declarations = ctx.typeDeclarations;
  if (declarations === undefined) return projectDeclaresType(ctx, binding.type);
  return rustOwnDeclaredTypeNames(declarations).has(binding.type);
}

const OWN_DECLARED_TYPE_NAMES = new WeakMap<object, ReadonlySet<string>>();

/** Short names of every type the run saw declared (re-openings excluded), cached per declaration table. */
function rustOwnDeclaredTypeNames(declarations: NonNullable<CallContext["typeDeclarations"]>): ReadonlySet<string> {
  const cached = OWN_DECLARED_TYPE_NAMES.get(declarations);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  for (const facts of Object.values(declarations)) {
    for (const fact of facts) if (!fact.reopens) names.add(fact.typeId.split(/::|\./).at(-1) ?? fact.typeId);
  }
  OWN_DECLARED_TYPE_NAMES.set(declarations, names);
  return names;
}

function withEntry<T extends LocalBinding | CallResultBinding>(
  record: Readonly<Record<string, T[]>> | undefined,
  name: string,
  entries: T[],
): Record<string, T[]> {
  const out = Object.assign(createIdentifierRecord<T[]>(), record);
  out[name] = entries;
  return out;
}

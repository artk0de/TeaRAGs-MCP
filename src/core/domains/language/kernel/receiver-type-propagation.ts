/**
 * Receiver type propagation — the language-neutral dotted-chain fold
 * (E1 seam 3, relocated from `ruby/resolver/type-propagation.ts`).
 *
 * Given `a.b.c` in receiver position, thread a type left to right: seed the
 * head, then ask `memberTypeOf` what each link yields. The first unknown hop
 * STOPS the walk and the whole receiver is untyped — never fabricate past an
 * unknown hop, because a wrong receiver type produces a wrong edge, and a
 * missing one produces silence a later pass can still answer.
 *
 * Everything language-shaped is a PORT. What an `@ivar` is, whether a bare
 * capitalized head is a constant, which env var caps the hop count, what
 * calling a member on a type yields — all of it belongs to the language, and
 * none of it belongs here. The four ports are the entire contract; a language
 * that can fill them gets multi-hop receiver typing for free.
 *
 * Ports are STATELESS: `ctx` is threaded as an argument so each language can
 * export ONE frozen singleton, and the fold allocates nothing per call site.
 */

import type { CallContext } from "../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../contracts/types/language.js";
import { typeRefReceiverForm } from "./type-ref.js";

export interface ReceiverTypePorts {
  /** The language's answer for a receiver with no dot in it. */
  singleHopType: (receiver: string, atLine: number, ctx: CallContext) => TypeRef | undefined;
  /**
   * A chain head that is not itself a value — a bare constant, a module alias.
   * The link arrives RAW, parens included: whether it was a CALL is
   * load-bearing (`mod.Cls()` is an instance, `mod.Cls` is the class), so the
   * port strips its own args. `consumedMembers` says how many leading links
   * the seed accounts for: 1 when the seed IS `head.firstLink`, 0 when it
   * types `head` alone.
   */
  seedHead: (
    head: string,
    firstLink: string | undefined,
    ctx: CallContext,
  ) => { type: TypeRef; consumedMembers: 0 | 1 } | undefined;
  /** What calling `member` on a receiver of type `recv` yields. */
  memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext) => TypeRef | undefined;
  /** Hop cap; a chain longer than this is untyped rather than half-walked. */
  maxHops: () => number;
}

/** Default maximum chain hops when a language's env override is unset. */
export const CHAIN_MAX_HOPS_DEFAULT = 4;

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
export function stripCallArgs(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}

/**
 * The static {@link TypeRef} for a receiver — single-hop or multi-hop chain.
 *
 * Every answer passes through {@link typeRefReceiverForm} exactly once, at this
 * boundary, so a NILABLE type reaches callers as the one arm a call on it can
 * actually dispatch to. Hops inside the walk stay RAW: collapsing per hop would
 * change what a multi-arm intermediate resolves to.
 */
export function propagateReceiverType(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  return typeRefReceiverForm(receiverTypeRefOf(receiver, atLine, ctx, ports));
}

/** {@link propagateReceiverType}'s lookup, before the receiver-form collapse. */
function receiverTypeRefOf(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  if (receiver.includes(".")) return propagateChain(receiver, atLine, ctx, ports);
  return ports.singleHopType(receiver, atLine, ctx);
}

/**
 * Thread a dotted chain receiver through the fold.
 *
 * 1. Split into `[head, link1, link2, …]`.
 * 2. Seed: `seedHead` first (a head the language can type together with its
 *    first link), else recurse into the single-hop path for `head` alone.
 * 3. For each remaining link: `t = memberTypeOf(t, link)`. First `undefined`
 *    STOPS and the whole receiver is untyped.
 * 4. A chain longer than `maxHops()` links is untyped.
 */
function propagateChain(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  const segments = receiver.split(".");
  const head = segments[0];
  if (!head) return undefined;

  const links = segments.slice(1);
  if (links.length > ports.maxHops()) return undefined;

  let current: TypeRef | undefined;
  let startLink = 0;
  const seeded = ports.seedHead(head, links[0], ctx);
  if (seeded !== undefined) {
    current = seeded.type;
    startLink = seeded.consumedMembers;
  } else {
    current = propagateReceiverType(head, atLine, ctx, ports);
  }
  if (current === undefined) return undefined;

  for (let i = startLink; i < links.length; i++) {
    current = ports.memberTypeOf(current, stripCallArgs(links[i]), ctx);
    if (current === undefined) return undefined; // STOP-at-unknown-hop
  }

  return current;
}

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
  /**
   * How a receiver becomes HOPS. Defaults to a plain `split(".")`; a language
   * whose receivers carry bracketed groups supplies {@link splitReceiverHops}
   * instead (bd tea-rags-mcp-w205u, E4.6b-1).
   *
   * It is a PORT and not the fold's own rule because Ruby measured a real
   * difference: `StatusFilter.new(quote.quoted_status, account).filter_state`
   * is 34 mastodon sites the bracket-aware split newly types, and none of them
   * is measured. Python opts in on 44 measured rows; Ruby keeps the split it
   * shipped until a Ruby increment measures the change.
   */
  splitReceiverHops?: (receiver: string) => string[];
}

/** Default maximum chain hops when a language's env override is unset. */
export const CHAIN_MAX_HOPS_DEFAULT = 4;

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
export function stripCallArgs(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}

/**
 * Split `text` on `separator` at BRACKET DEPTH ZERO, outside quotes.
 *
 * The one scanner every depth-aware split in this engine shares: hops on `.`
 * here, and a language's argument list on `,` through its own port. Unbalanced
 * input — which a truncated call text produces — yields the whole string as one
 * element rather than throwing or half-splitting, because a partial parse of a
 * receiver is exactly the garbage this replaces.
 */
export function splitAtBracketDepthZero(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote !== null) return [text];
  parts.push(text.slice(start));
  return parts;
}

/**
 * Split a receiver into HOPS on `.` at bracket depth 0.
 *
 * `Notification(user=self.user)` is ONE hop, not three: the dots inside a
 * call's arguments, a subscript or a literal belong to the argument, not to the
 * chain (bd tea-rags-mcp-w205u, E4.6b-1). A bare `receiver.split(".")` shredded
 * `datatable.Datatable[Benefit, S](…)` and `Cls(kw=self.x, …)` into segments
 * that typed to nothing — 44 measured rows across polar, netbox and httpx.
 *
 * A receiver carrying no bracketed group splits exactly as `split(".")` does,
 * which is what makes this safe for every language sharing the fold.
 */
export function splitReceiverHops(receiver: string): string[] {
  return splitAtBracketDepthZero(receiver, ".");
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
  const hops = (ports.splitReceiverHops ?? defaultReceiverHops)(receiver);
  if (hops.length > 1) return propagateChain(hops, atLine, ctx, ports);
  return ports.singleHopType(receiver, atLine, ctx);
}

/** The hop split every language shipped before the port existed. */
function defaultReceiverHops(receiver: string): string[] {
  return receiver.split(".");
}

/**
 * Thread a dotted chain receiver through the fold.
 *
 * 1. `segments` arrives ALREADY split as `[head, link1, link2, …]` — the caller
 *    owns the {@link splitReceiverHops} scan so it happens once per receiver.
 * 2. Seed: `seedHead` first (a head the language can type together with its
 *    first link), else recurse into the single-hop path for `head` alone.
 * 3. For each remaining link: `t = memberTypeOf(t, link)`. First `undefined`
 *    STOPS and the whole receiver is untyped.
 * 4. A chain longer than `maxHops()` links is untyped.
 */
function propagateChain(
  segments: readonly string[],
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
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

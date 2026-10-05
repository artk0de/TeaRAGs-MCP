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
  /**
   * What calling `member` WITH the argument list `argumentText` on `recv`
   * yields — asked INSTEAD of {@link memberTypeOf} for a link that carries a
   * balanced argument list, so the port owns its own fallback. OPTIONAL: a
   * language whose return types never depend on an argument omits it, and
   * the fold strips the arguments and asks `memberTypeOf` as it always did.
   *
   * It exists because a return can be BOUND by an argument: Swift's
   * `read<U>(_ closure: (Value) -> U) -> U` given the key path `\.prop`
   * returns `Value.prop`'s type, and nothing but the argument says so (bd
   * tea-rags-mcp-y99pg). What an argument means is the language's question;
   * the kernel only hands the text over.
   */
  memberCallTypeOf?: (recv: TypeRef, member: string, argumentText: string, ctx: CallContext) => TypeRef | undefined;
  /**
   * What READING `member` on `recv` without calling it yields — asked INSTEAD
   * of {@link memberTypeOf} for a link that carries NO argument list (bd
   * tea-rags-mcp-m99j1.1.20). OPTIONAL: in a language where a bare member
   * reference is itself a call (Ruby's `user.name`), the two reads are one and
   * the language omits it.
   *
   * It exists because in Python they are not one: `obj.prop` on a `@property`
   * yields its return, while `obj.method` on a plain method yields a bound
   * method whose return belongs to `obj.method()`.
   */
  memberAttributeTypeOf?: (recv: TypeRef, member: string, ctx: CallContext) => TypeRef | undefined;
  /**
   * The type ITERATING a value of type `container` yields, or `null` when the
   * language cannot say (bd tea-rags-mcp-m99j1.1.18). Which containers yield
   * what — a list its element, a project class through its own iterator
   * protocol — is the language's rule. OPTIONAL: a language with no
   * iteration bindings omits it, and nothing in the fold calls it.
   */
  elementTypeOf?: (container: TypeRef, ctx: CallContext) => TypeRef | null;
  /**
   * The type of an attribute link from its NAME ALONE, or `undefined` when the
   * name does not fix one (bd tea-rags-mcp-m99j1.1.37). Consulted ONLY where
   * the fold has lost the link's owner — an untyped head, or a hop after an
   * unknown one — and only for a bare attribute link, never a call: a typed
   * owner always keeps {@link memberTypeOf}'s answer, including its refusal.
   *
   * It exists because a framework can install a member on every instance it
   * manages under a name nothing else uses: Django's `obj._meta` is `Options`
   * whatever `obj` is, and 28 of 150 sampled django chain misses stopped at the
   * untyped owner in front of such a name. Which names qualify — and under which
   * declared dependencies — is the language's data. OPTIONAL: a language that
   * omits it keeps STOP-at-unknown-hop exactly.
   */
  ownerIndependentMemberType?: (member: string, ctx: CallContext) => TypeRef | undefined;
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
 * The text inside a chain segment's argument list — the group opened by its
 * FIRST `(` (`read(\.p)` → `\.p`) — or `undefined` when the segment has none
 * or the group never closes. Scanned with {@link splitAtBracketDepthZero}'s
 * bracket-and-quote rules, so a `)` inside a string or a nested call does not
 * end it.
 */
export function callArgumentText(segment: string): string | undefined {
  const paren = segment.indexOf("(");
  if (paren === -1) return undefined;
  let depth = 0;
  let quote: string | null = null;
  for (let i = paren; i < segment.length; i++) {
    const ch = segment[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ")" || ch === "]" || ch === "}") && --depth === 0) return segment.slice(paren + 1, i);
  }
  return undefined;
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
 * What ONE raw link yields on `recv`: a link with an argument list goes to
 * `memberCallTypeOf`, one without to `memberAttributeTypeOf`, each falling back
 * to `memberTypeOf` when the language omits that port — so a language with
 * neither optional port reads every link exactly as before they existed.
 */
function linkType(recv: TypeRef, link: string, ctx: CallContext, ports: ReceiverTypePorts): TypeRef | undefined {
  const member = stripCallArgs(link);
  if (ports.memberCallTypeOf === undefined && ports.memberAttributeTypeOf === undefined) {
    return ports.memberTypeOf(recv, member, ctx);
  }
  const argumentText = callArgumentText(link);
  if (argumentText === undefined) {
    return (ports.memberAttributeTypeOf ?? ports.memberTypeOf)(recv, member, ctx);
  }
  return ports.memberCallTypeOf === undefined
    ? ports.memberTypeOf(recv, member, ctx)
    : ports.memberCallTypeOf(recv, member, argumentText, ctx);
}

/**
 * Thread a dotted chain receiver through the fold.
 *
 * 1. `segments` arrives ALREADY split as `[head, link1, link2, …]` — the caller
 *    owns the {@link splitReceiverHops} scan so it happens once per receiver.
 * 2. Seed: `seedHead` first (a head the language can type together with its
 *    first link), else recurse into the single-hop path for `head` alone.
 * 3. For each remaining link: `t = memberTypeOf(t, link)`. First `undefined`
 *    STOPS and the whole receiver is untyped — unless a LATER bare attribute
 *    link answers {@link ReceiverTypePorts.ownerIndependentMemberType}, in
 *    which case the walk resumes from that link. Every link between the lost
 *    owner and the resumed one is skipped, never typed.
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
  let nextLink = 0;
  const seeded = ports.seedHead(head, links[0], ctx);
  if (seeded !== undefined) {
    current = seeded.type;
    nextLink = seeded.consumedMembers;
  } else {
    current = propagateReceiverType(head, atLine, ctx, ports);
  }

  while (nextLink < links.length || current === undefined) {
    if (current === undefined) {
      const resumed = resumeAfterLostOwner(links, nextLink, ctx, ports);
      if (resumed === undefined) return undefined; // STOP-at-unknown-hop
      current = resumed.type;
      nextLink = resumed.followingLink;
      continue;
    }
    current = linkType(current, links[nextLink++], ctx, ports);
  }

  return current;
}

/**
 * The first bare attribute link at or after `from` whose type the language
 * fixes by name alone, and the link after it — or `undefined` when the port is
 * absent or no link qualifies. A link carrying any bracketed group is a call or
 * a subscript, whose result the name does not fix.
 */
function resumeAfterLostOwner(
  links: readonly string[],
  from: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): { type: TypeRef; followingLink: number } | undefined {
  if (ports.ownerIndependentMemberType === undefined) return undefined;
  for (let i = from; i < links.length; i++) {
    if (!BARE_ATTRIBUTE.test(links[i])) continue;
    const type = ports.ownerIndependentMemberType(links[i], ctx);
    if (type !== undefined) return { type, followingLink: i + 1 };
  }
  return undefined;
}

/** A link that is one identifier — no call, subscript or other bracketed group. */
const BARE_ATTRIBUTE = /^[A-Za-z_]\w*$/;

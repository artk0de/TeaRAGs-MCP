import { UnionDispatchResolver, type UnionDispatchPorts } from "../../../kernel/index.js";
import { createRubyTypeMemberLookup } from "../ruby-type-member-lookup.js";
import { typeOfReceiver } from "../type-propagation.js";
import { CONE_MAX_DEFAULT, isRubyPath, type ResolverConfig } from "./shared.js";

/**
 * Ruby's union-receiver cone fan-out (bd tea-rags-mcp Task 1.7) — the kernel
 * {@link UnionDispatchResolver} over Ruby's ports. A receiver carrying a YARD
 * union `[A, B]` fans out to every in-project arm defining the member; a
 * `class` arm answers through the static MRO walk, an `instance` arm through the
 * instance walk (`createRubyTypeMemberLookup`), and only Ruby files count.
 *
 * Placed BEFORE `RubyConeDispatchResolver` in the component list: union
 * evidence is stronger than CHA subtype inference — the YARD annotation names
 * the exact possible types, whereas CHA only knows descendants. When this
 * component returns `[]` (no union receiver, or no in-project targets) the cone
 * proceeds as usual.
 */
const RUBY_UNION_DISPATCH_PORTS: UnionDispatchPorts = {
  typeOfReceiver: (call, ctx) => typeOfReceiver(call.receiver, call.startLine, ctx) ?? null,
  ownsPath: isRubyPath,
};

export class RubyUnionDispatchResolver extends UnionDispatchResolver {
  constructor(cfg: ResolverConfig) {
    super(RUBY_UNION_DISPATCH_PORTS, createRubyTypeMemberLookup(cfg.mode), cfg.coneMax ?? CONE_MAX_DEFAULT);
  }
}

/**
 * `repo.save()` when the walker bound `repo` to a type in this file.
 *
 * The member is `Type#member`, then `Type.member`, and only when that id is
 * in the symbol table. A type the index does not hold, or a member it does
 * not declare, resolves to null (`dropOnTypedMiss`): the bound type is
 * authoritative, so a later pass must not guess.
 */

import { createTypeMemberLookup, LocalBindingSymbolResolutionStrategy } from "../../../kernel/index.js";
import { kotlinReceiverType } from "../kotlin-receiver-type.js";
import { lookupKotlinTypeMember, type ResolverConfig } from "./shared.js";

export class KotlinTypedReceiverSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    super(
      "typedReceiver",
      { typeOfReceiver: (call, ctx) => kotlinReceiverType(call, ctx) },
      createTypeMemberLookup((type, member, ctx) => lookupKotlinTypeMember(type, member, ctx, cfg.mode)),
      { dropOnTypedMiss: true, requirePinnedTarget: true },
    );
  }
}

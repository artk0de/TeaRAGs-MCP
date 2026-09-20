export { SwiftSuperSymbolResolutionStrategy } from "./swift-super.js";
export { SwiftLocalBindingSymbolResolutionStrategy } from "./swift-local-binding.js";
export { SwiftSelfMemberSymbolResolutionStrategy } from "./swift-self-member.js";
export { SwiftStoredPropertyTypeSymbolResolutionStrategy } from "./swift-stored-property-type.js";
export { SwiftScopedTypeReceiverSymbolResolutionStrategy } from "./swift-scoped-type-receiver.js";
export { SwiftEnclosingBareCallSymbolResolutionStrategy } from "./swift-enclosing-bare-call.js";
export { SwiftExtensionScopeMemberSymbolResolutionStrategy } from "./swift-extension-scope-member.js";
export { SwiftGlobalShortNameSymbolResolutionStrategy } from "./swift-global-short-name.js";
export {
  lookupEnclosingTypeMemberInFile,
  lookupSwiftTypeMember,
  resolveSwiftBoundTypeMember,
  SWIFT_PSEUDO_RECEIVERS,
  type SwiftResolverConfig,
} from "./shared.js";

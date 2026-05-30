export { GoLocalBindingSymbolResolutionStrategy } from "./go-local-binding.js";
export { GoReturnTypeBindingSymbolResolutionStrategy } from "./go-return-type-binding.js";
export { GoImportMatchSymbolResolutionStrategy } from "./go-import-match.js";
export { GoReceiverDropSymbolResolutionStrategy } from "./go-receiver-drop.js";
export { GoGlobalShortNameSymbolResolutionStrategy } from "./go-global-short-name.js";
export {
  importMatchesReceiver,
  isKnownTypeSymbol,
  resolveByLocalType,
  type ResolverConfig,
} from "./shared.js";

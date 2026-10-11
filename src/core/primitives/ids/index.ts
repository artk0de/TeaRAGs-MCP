/**
 * Identity rules — primitives layer (`core/primitives/`), I/O-free and
 * importable by every core layer: the AST → symbolId classification rules
 * under `symbolid/`, the collection identity rule (`collection-identity.ts`)
 * and the per-file content hash (`content-hash.ts`). Consumers import this
 * barrel, never a file behind it.
 */

export { fileContentHash } from "./content-hash.js";

export {
  collectionAliasEntryFromQdrant,
  collectionAliasOfRegistryEntry,
  findAliasTarget,
  physicalCollectionNameFromDaemonRequest,
  physicalCollectionNamesListedByStorage,
  resolveCollectionName,
  resolvePhysicalCollection,
  versionedPhysicalCollectionName,
} from "./collection-identity.js";

export {
  INSTANCE_METHOD_SEPARATOR,
  classExpressionName,
  classPropertyFunction,
  classifyMethod,
  constObjectNamespaceContainerName,
  constObjectNamespaceName,
  constObjectNamespaceOwner,
  enclosingClassScopeNames,
  enclosingFactoryScopeNames,
  functionValuedDeclaratorName,
  isFunctionValuedExpression,
  isStaticMethodNode,
  lastNameSegment,
  moduleLevelFunctionDeclarationNames,
  moduleLevelFunctionDeclaratorName,
  rubyInsideSingletonClass,
  splitMethodSymbol,
  unwrapTypeAssertions,
} from "./symbolid/index.js";
export type { ClassPropertyFunction, MethodClassification } from "./symbolid/index.js";

import type {
  AnchorIdentifierTypeRow,
  CodegraphIdentifierStore,
  IdentifierCalleeAggregateRow,
  IdentifierCalleeScopeQuery,
  IdentifierLanguageCountQuery,
  IdentifierLanguageCountRow,
  IdentifierNameKindTypeRow,
  IdentifierNameScopeQuery,
  IdentifierNameTypeRow,
  IdentifierReplaceEntry,
  IdentifierShapeSampleQuery,
  IdentifierShapeSampleRow,
  IdentifierTypeAggregateQuery,
  IdentifierTypeAggregateRow,
  IdentifierTypeScopeQuery,
  MethodHeadWordQuery,
  MethodHeadWordRow,
  MethodNamePatternQuery,
  MethodNameRow,
  MethodTailVerbQuery,
  MethodTailVerbRow,
  SymbolId,
  TypeDeclarationReplaceEntry,
  TypeNameQuery,
  TypeNameRow,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/**
 * `CodegraphIdentifierStore` over the daemon socket (naming lexicon, bd
 * tea-rags-mcp-4p3sb.8). Readonly query arrays are copied into plain arrays —
 * the op params are the wire shape.
 */
export class DaemonIdentifierStoreProxy implements CodegraphIdentifierStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async replaceIdentifiersBulk(entries: readonly IdentifierReplaceEntry[]): Promise<void> {
    await this.ops.call("replaceIdentifiersBulk", { entries: [...entries] });
  }

  async replaceTypeDeclarationsBulk(entries: readonly TypeDeclarationReplaceEntry[]): Promise<void> {
    await this.ops.call("replaceTypeDeclarationsBulk", { entries: [...entries] });
  }

  async aggregateIdentifiersByType(q: IdentifierTypeAggregateQuery): Promise<IdentifierTypeAggregateRow[]> {
    return (await this.ops.call("aggregateIdentifiersByType", {
      types: [...q.types],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
      groupByMultiplicity: q.groupByMultiplicity,
      countSameTypeSiblings: q.countSameTypeSiblings,
      countHolders: q.countHolders,
      groupByOwnerKind: q.groupByOwnerKind,
    })) as IdentifierTypeAggregateRow[];
  }

  async aggregateIdentifiersByCallee(q: IdentifierCalleeScopeQuery): Promise<IdentifierCalleeAggregateRow[]> {
    return (await this.ops.call("aggregateIdentifiersByCallee", {
      callees: [...q.callees],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
      countHolders: q.countHolders,
    })) as IdentifierCalleeAggregateRow[];
  }

  async anchorIdentifierTypes(symbolIds: readonly SymbolId[]): Promise<AnchorIdentifierTypeRow[]> {
    return (await this.ops.call("anchorIdentifierTypes", { symbolIds: [...symbolIds] })) as AnchorIdentifierTypeRow[];
  }

  async identifierNameTypes(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<IdentifierNameTypeRow[]> {
    return (await this.ops.call("identifierNameTypes", {
      names: [...names],
      excludePaths: excludePaths === undefined ? undefined : [...excludePaths],
      languages: languages === undefined ? undefined : [...languages],
    })) as IdentifierNameTypeRow[];
  }

  async existingSymbolShortNames(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<string[]> {
    return (await this.ops.call("existingSymbolShortNames", {
      names: [...names],
      excludePaths: excludePaths === undefined ? undefined : [...excludePaths],
      languages: languages === undefined ? undefined : [...languages],
    })) as string[];
  }

  async readMethodHeadWords(q: MethodHeadWordQuery): Promise<MethodHeadWordRow[]> {
    return (await this.ops.call("readMethodHeadWords", { query: q })) as MethodHeadWordRow[];
  }

  async readMethodTailVerbs(q: MethodTailVerbQuery): Promise<MethodTailVerbRow[]> {
    return (await this.ops.call("readMethodTailVerbs", { query: q })) as MethodTailVerbRow[];
  }

  async readMethodNamesMatching(q: MethodNamePatternQuery): Promise<MethodNameRow[]> {
    return (await this.ops.call("readMethodNamesMatching", { query: q })) as MethodNameRow[];
  }

  async countIdentifiers(q: IdentifierTypeScopeQuery): Promise<number> {
    return (await this.ops.call("countIdentifiers", {
      types: [...q.types],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
    })) as number;
  }

  async aggregateIdentifiersByName(q: IdentifierNameScopeQuery): Promise<IdentifierNameKindTypeRow[]> {
    return (await this.ops.call("aggregateIdentifiersByName", {
      names: [...q.names],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
      countHolders: q.countHolders,
    })) as IdentifierNameKindTypeRow[];
  }

  async identifierLanguageCounts(q: IdentifierLanguageCountQuery): Promise<IdentifierLanguageCountRow[]> {
    return (await this.ops.call("identifierLanguageCounts", {
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      pathSuffixes: q.pathSuffixes === undefined ? undefined : [...q.pathSuffixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
    })) as IdentifierLanguageCountRow[];
  }

  async sampleIdentifierShapes(q: IdentifierShapeSampleQuery): Promise<IdentifierShapeSampleRow[]> {
    return (await this.ops.call("sampleIdentifierShapes", {
      limit: q.limit,
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
    })) as IdentifierShapeSampleRow[];
  }

  async readTypeNameRows(q: TypeNameQuery): Promise<TypeNameRow[]> {
    return (await this.ops.call("readTypeNameRows", { query: q })) as TypeNameRow[];
  }
}

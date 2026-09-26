/**
 * TreeSitterChunker - AST-aware code chunking using tree-sitter
 * Primary chunking strategy for supported languages
 *
 * OPTIMIZATION: Lazy-loads parsers on first use to reduce startup time.
 * Before: All 9 parsers loaded at construction (~3-5 seconds)
 * After: Parsers loaded on demand (~0ms startup, ~100-200ms first use per language)
 */

import Parser from "tree-sitter";

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { ChunkDecision } from "../../../../contracts/types/chunker.js";
import type {
  LanguageChunkerHooks,
  LanguageFactoryDescriptor,
  LanguageKernel,
  SymbolIdComposer,
} from "../../../../contracts/types/language.js";
import { materializeTree } from "../../../../infra/materialize.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  classifyMethod,
  constObjectNamespaceContainerName,
  constObjectNamespaceOwner,
  enclosingClassScopeNames,
  enclosingFactoryScopeNames,
  type MethodClassification,
} from "../../../../infra/symbolid/index.js";
import type { ChunkerConfig, CodeChunk } from "../../../../types.js";
import { AST_NOT_PROCESSED_REASON, FileParseError } from "../../errors.js";
import { AstSymbolSplitter } from "./ast-symbol-splitter.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character.js";
import type { LanguageConfig } from "./config.js";
import { planContainerRemainder } from "./container-remainder.js";
import { createHookContext, type ChunkingHook, type HookContext } from "./hooks/types.js";
import { MarkdownChunker } from "./markdown-chunker.js";
import { SymbolIdDisambiguator } from "./symbol-id-disambiguator.js";

/**
 * Everything one `processChildren` pass holds constant while it routes each
 * child to an emitter. Bundled so the three emitters take (node, pass) instead
 * of re-threading ten positional arguments each.
 */
interface ChildChunkEmissionPass {
  ctx: HookContext;
  langConfig: LanguageConfig;
  code: string;
  filePath: string;
  language: string;
  parentName: string | undefined;
  parentType: string;
  /**
   * The container node `parentName` names. A child found BELOW a class the
   * container does not name (a class declared inside a function) composes that
   * class in between — see `enclosingClassScopeNames`.
   */
  container: AstNode;
  /** Output accumulator — emitters push in emission order. */
  chunks: CodeChunk[];
  hierarchyHeaders: string[];
  /** Per-pass overload counter shared by the oversized and leaf emitters. */
  overloads: SymbolIdDisambiguator;
}

/** A run of content lines cut by the `enforceMaxChunkSize` post-pass. */
interface ContentSegment {
  text: string;
  firstLine: number;
  lastLine: number;
}

/**
 * Who the parts of one split symbol belong to. Every part is emitted as
 * `${symbolId}#partN` with `parentSymbolId = symbolId`, so the symbol id itself
 * names the whole and find_symbol can fold the parts back under it.
 */
interface SplitSymbolIdentity {
  symbolId: string | undefined;
  name: string | undefined;
  chunkType: NonNullable<CodeChunk["metadata"]["chunkType"]>;
  /** The parts' parentType; defaults to the symbol's own (unwrapped) node type. */
  parentType?: string;
  /** Transient classifier flag, preserved on every part. */
  claimed?: boolean;
  /**
   * 0-based first row of the comment block a comment-capture hook attached to
   * the symbol (bd tea-rags-mcp-u7tjf). The block opens `#part1`, whose
   * `startLine` then starts there — the leaf path's `methodStartLines` rule.
   */
  leadingStartRow?: number;
  /**
   * The enclosing containers' headers, rendered (`buildHierarchyPrefix`), for
   * a MEMBER split into parts (bd tea-rags-mcp-jgb5a). Every part opens with
   * it, exactly as the unsplit member chunk does, and its length comes out of
   * every part's budget. Absent for a top-level symbol.
   */
  hierarchyPrefix?: string;
}

/**
 * Who a container's remainder chunk belongs to (bd tea-rags-mcp-deoki). The
 * symbolId is the CONTAINER's own id — the remainder is the container's chunk,
 * not a sibling of it — so an oversized remainder splits into
 * `${symbolId}#partN` like any other symbol.
 */
interface ContainerRemainderIdentity {
  symbolId: string | undefined;
  name: string | undefined;
  parentSymbolId: string | undefined;
  parentType: string;
  chunkType: NonNullable<CodeChunk["metadata"]["chunkType"]>;
}

export class TreeSitterChunker implements CodeChunker {
  /** Cache of initialized parsers (lazy-loaded) */
  private readonly parserCache: Map<string, LanguageConfig> = new Map();
  private readonly fallbackChunker: CharacterChunker;
  /** Splits an oversized symbol on statement boundaries (bd tea-rags-mcp-y5vx4). */
  private readonly symbolSplitter: AstSymbolSplitter;
  private readonly markdownChunker: MarkdownChunker;
  /** Track loading promises to avoid duplicate loads */
  private readonly loadingPromises: Map<string, Promise<LanguageConfig | null>> = new Map();

  /** Maximum lines for a chunk to be considered a merge candidate */
  private static readonly MERGE_THRESHOLD = 5;
  /** Maximum gap (in source lines) between mergeable chunks */
  private static readonly MERGE_GAP = 2;
  /** Chunk types eligible for merging */
  private static readonly MERGEABLE_TYPES = new Set(["block", "interface"]);

  /**
   * Build symbolId from name and optional parentName.
   * Instance methods use "#" separator: "Parent#method"
   * Static methods use "." separator: "Parent.method"
   * Everything else joins with the language's scope separator: "Parent.nested"
   * Top-level symbols have no separator: "name"
   *
   * `methodKind` is the TRI-state `classifyMethod` returns, not a boolean.
   * bd tea-rags-mcp-pdv8m — the parameter used to be `isStatic: boolean`, which
   * collapsed `classifyMethod`'s third state (null = binds no instance, join as
   * a namespace) into `"instance"`. A `method_definition` inside an object
   * literal passed as a CALL ARGUMENT — `install({ handle() {} })` — is exactly
   * that state: cg_symbols holds `register.handle` while the chunker wrote
   * `register#handle`, an id no graph row carries. bd tea-rags-mcp-62hzr fixed
   * the sibling declarator shape (`const X = { m() {} }`) upstream in
   * `constObjectNamespaceOwner` instead of widening this composer, so the
   * non-declarator shape stayed broken. The `#`/`.` rule for real class methods
   * is unchanged: `classifyMethod` still decides, this just stops discarding
   * what it decided.
   */
  private buildSymbolId(
    name?: string,
    parentName?: string,
    methodKind?: MethodClassification | null,
    scopeSeparator?: string,
  ): string | undefined {
    if (!name) return undefined;
    if (!parentName) return name;
    return this.symbolIds.compose(parentName, name, { methodKind: methodKind ?? undefined, scopeSeparator });
  }

  /**
   * Check if a tree-sitter node has a specific modifier (e.g., "static").
   */
  private hasModifier(node: AstNode, modifier: string): boolean {
    for (const child of node.children) {
      if (child.type === modifier || child.text === modifier) return true;
    }
    return false;
  }

  /**
   * Compute 1-based endLine from a tree-sitter node.
   * tree-sitter endPosition.row is inclusive (same row for single-line nodes),
   * so we ensure endLine > startLine for at least 1 line span.
   */
  private computeEndLine(node: AstNode): number {
    return Math.max(node.startPosition.row + 2, node.endPosition.row + 1);
  }

  /**
   * For Python's `decorated_definition` wrapper, return the inner
   * `function_definition` / `class_definition` for semantic operations
   * (name extraction, static-method classification, chunkType). The
   * outer wrapper is kept for chunk content and line range so the
   * decorator stays visible in the emitted chunk. Every other node
   * passes through unchanged.
   *
   * Required for bd tea-rags-mcp-t6sr — `@classmethod` / `@staticmethod`
   * methods would otherwise emit `chunkType: "block"` and `name: undefined`
   * because the wrapper carries no `name` field and `classifyMethod`
   * only branches on the inner `function_definition` type.
   */
  private unwrapDecoratedDefinition(node: AstNode): AstNode {
    if (node.type !== "decorated_definition") return node;
    const inner = node.childForFieldName("definition");
    if (inner) return inner;
    // Fall back to scanning children when the grammar omits the
    // `definition` field name (older tree-sitter-python versions).
    /* v8 ignore next 4 -- defensive: current grammar always emits field name */
    for (const child of node.children) {
      if (child.type === "function_definition" || child.type === "class_definition") return child;
    }
    /* v8 ignore next */
    return node;
  }

  /**
   * Cross-language symbolId mapper, injected via DI from the composition
   * layer (`api/internal/`). The chunker engine never imports the concrete
   * composer — `domains/ingest` may not import `domains/language` (eslint
   * leaf-domain guard). The worker composition root constructs the concrete
   * `DefaultSymbolIdComposer` and passes it here; tests inject it directly.
   * See `.claude/rules/symbolid-convention.md` + spec §5.
   */
  private readonly symbolIds: SymbolIdComposer;

  /**
   * Per-language capability source, injected via DI from the composition layer
   * (the chunker worker root in `api/internal/chunker-worker.ts`). The chunker
   * engine never imports the concrete factory or the legacy `LANGUAGE_DEFINITIONS`
   * map — `domains/ingest` may not import `domains/language` (eslint leaf-domain
   * guard) and the consolidation routes all per-language config through the
   * `contracts/` `LanguageFactoryDescriptor` interface. `create(lang)` is cached per
   * language by `getLanguageConfig`. See spec §5 + `.claude/rules/domain-boundaries.md`.
   */
  private readonly languages: LanguageFactoryDescriptor;

  constructor(
    private readonly config: ChunkerConfig,
    symbolIds: SymbolIdComposer,
    languages: LanguageFactoryDescriptor,
  ) {
    this.symbolIds = symbolIds;
    this.languages = languages;
    this.fallbackChunker = new CharacterChunker(config);
    this.symbolSplitter = new AstSymbolSplitter(config.maxChunkSize);
    this.markdownChunker = new MarkdownChunker({ maxChunkSize: this.config.chunkSize }, this.fallbackChunker);
    // NO parser initialization here - lazy load on demand!
  }

  /**
   * Get or lazily initialize parser for a language.
   * Returns null if language is not supported.
   */
  private async getLanguageConfig(language: string): Promise<LanguageConfig | null> {
    // Check cache first
    const cached = this.parserCache.get(language);
    if (cached) {
      return cached;
    }

    // Check if already loading (avoid duplicate loads)
    const loading = this.loadingPromises.get(language);
    if (loading) {
      return loading;
    }

    // Check if language is registered with the factory
    const provider = this.tryGetProvider(language);
    if (!provider?.chunkerHooks) {
      return null;
    }

    // Start loading
    const loadPromise = this.initializeParser(language, provider.kernel, provider.chunkerHooks);
    this.loadingPromises.set(language, loadPromise);

    try {
      const config = await loadPromise;
      if (config) {
        this.parserCache.set(language, config);
      }
      return config;
    } finally {
      this.loadingPromises.delete(language);
    }
  }

  /**
   * Resolve the `LanguageProvider` for a language via the injected factory,
   * returning `null` for unregistered languages (mirrors the old
   * `LANGUAGE_DEFINITIONS[lang]` undefined check — `factory.create` throws
   * `UnsupportedLanguageError`, so gate on `supported()` first).
   */
  private tryGetProvider(language: string): ReturnType<LanguageFactoryDescriptor["create"]> | null {
    return this.languages.supported().includes(language) ? this.languages.create(language) : null;
  }

  /**
   * Initialize a parser for a specific language from its `LanguageProvider`
   * capabilities — `kernel` carries parser load + namespace config, `chunkerHooks`
   * carries the chunk-boundary fields. Field-for-field equivalent to the old
   * `LANGUAGE_DEFINITIONS` read (the legacy adapter wraps the same source).
   */
  private async initializeParser(
    language: string,
    kernel: LanguageKernel,
    hooks: LanguageChunkerHooks,
  ): Promise<LanguageConfig | null> {
    try {
      const startTime = Date.now();

      // Dynamic import of language module
      const mod = (await kernel.loadModule()) as Record<string, unknown>;
      const langModule = (kernel.extractLanguage ? kernel.extractLanguage(mod) : mod.default || mod) as Parser.Language;

      // Create and configure parser
      const parser = new Parser();
      parser.setLanguage(langModule);

      if (isDebug()) {
        console.error(`[TreeSitter] Lazy-loaded ${language} parser in ${Date.now() - startTime}ms`);
      }

      return {
        parser,
        chunkableTypes: hooks.chunkableTypes,
        childChunkTypes: hooks.childChunkTypes,
        alwaysExtractChildren: hooks.alwaysExtractChildren,
        isDocumentation: hooks.isDocumentation,
        hooks: hooks.hooks,
        nameExtractor: hooks.nameExtractor,
        scopeContainerTypes: kernel.scopeContainerTypes,
        scopeSeparator: kernel.scopeSeparator,
        keepShortChildChunkTypes: hooks.keepShortChildChunkTypes,
        disambiguateOverloads: kernel.disambiguateOverloads,
        classifier: hooks.classifier,
      };
    } catch (error) {
      console.error(`[TreeSitter] Failed to load parser for ${language}:`, error);
      return null;
    }
  }

  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
    return (await this.chunkWithTree(code, filePath, language)).chunks;
  }

  /**
   * yl9tv — the single parse site, surfacing the parsed `tree` alongside the
   * chunks so a codegraph-enabled worker can run the walker on the SAME parse
   * (no main-thread re-parse). `chunk()` delegates here and discards the tree;
   * behaviour for the chunk array is unchanged. `tree` is the successfully
   * parsed tree (even when the chunk array fell back to character chunking, so
   * the walker can still extract symbols — parity with the codegraph provider's
   * direct-mode `extractOneFile`); it is `null` only for documentation
   * languages, unsupported languages, and hard parse failures.
   */
  async chunkWithTree(
    code: string,
    filePath: string,
    language: string,
  ): Promise<{ chunks: CodeChunk[]; tree: MaterializedTree | null }> {
    // Documentation languages (markdown) skip tree-sitter entirely and route to
    // the remark-based MarkdownChunker. `isDocumentation` is the gate: markdown
    // is the only documentation language and the only one carrying the legacy
    // `skipTreeSitter` flag (which is not part of the LanguageChunkerHooks
    // contract — the two were always co-set), so gating on `isDocumentation`
    // alone is behaviour-identical to the old `skipTreeSitter && isDocumentation`.
    const provider = this.tryGetProvider(language);
    if (provider?.chunkerHooks?.isDocumentation) {
      return {
        chunks: this.enforceMaxChunkSize(await this.markdownChunker.chunk(code, filePath, language)),
        tree: null,
      };
    }

    const langConfig = await this.getLanguageConfig(language);
    if (!langConfig) {
      return {
        chunks: this.enforceMaxChunkSize(await this.fallbackChunker.chunk(code, filePath, language)),
        tree: null,
      };
    }

    // Captured at the single parse site so the shared character-fallback below
    // can tell a genuinely-broken AST (parse threw OR rootNode.hasError) — which
    // earns the distinct "AST not processed" quarantine reason when the fallback
    // ALSO fails — from a clean parse of a valid structureless file.
    let astBroken: boolean;
    let materializedTree: MaterializedTree | null;
    // The original parse-stage failure ("what prevented parsing") when parse()
    // threw — set on the catch path, undefined on the rootNode.hasError path
    // (no exception there; the syntax-error cause is derived from the tree).
    let parseError: unknown = undefined;

    try {
      // Materialize the native tree immediately after parse — ONE eager pass
      // captures all fragile native accessors (childForFieldName, parent,
      // namedChildren) into a plain-JS AstNode tree. Every downstream consumer
      // (findChunkableNodes, walker, collectSymbols) sees the deterministic
      // plain-JS tree; the native Parser.Tree is dropped here. Fixes rdv7d.
      const nativeTree = langConfig.parser.parse(code);
      astBroken = nativeTree.rootNode.hasError;
      const root = materializeTree(nativeTree.rootNode, code);
      materializedTree = { rootNode: root };

      const chunks: CodeChunk[] = [];
      const nodes = this.findChunkableNodes(root, langConfig.chunkableTypes, langConfig.hooks, code, filePath);

      for (const [index, node] of nodes.entries()) {
        const content = code.substring(node.startIndex, node.endIndex);
        const decision = langConfig.classifier?.classifyNode(node) ?? ({ kind: "passthrough" } as const);
        // Explicit drop.
        if (decision.kind === "skip") continue;
        // Min-length noise gate for statements without a stable symbolId. A
        // classifier `emit` decision bypasses it — these are top-level NAMED
        // symbols `find_symbol` must resolve (e.g. Go type aliases; replaces the
        // former `isGoNamedType` carve-out). bd tea-rags-mcp-iiq6.
        if (content.length < 50 && decision.kind !== "emit") continue;

        const hasChildTypes = langConfig.childChunkTypes && langConfig.childChunkTypes.length > 0;
        const isTooLarge = content.length > this.config.maxChunkSize;
        const shouldExtractChildren = hasChildTypes && (isTooLarge || langConfig.alwaysExtractChildren);

        if (shouldExtractChildren) {
          const handled = await this.chunkWithChildExtraction(node, langConfig, code, filePath, language, chunks);
          if (handled) continue;
        }

        this.chunkSingleNode(node, langConfig, index, code, filePath, language, chunks, decision);
      }

      // Parse produced usable chunks (or the file is too short to bother with a
      // character fallback): done. A degraded AST (rootNode.hasError) that still
      // yields chunks is indexed exactly as today — no quarantine, no marker.
      if (chunks.length > 0 || code.length <= 100) {
        return { chunks: this.enforceMaxChunkSize(this.mergeSmallChunks(chunks)), tree: materializedTree };
      }
      // Parse succeeded but yielded zero chunks on a non-trivial file — fall
      // through to the shared character-fallback site below (keeping the
      // materialized tree so the codegraph walker still sees symbols).
    } catch (error) {
      console.error(`Tree-sitter parsing failed for ${filePath}:`, error);
      // parse / materialize / node walk threw — the AST genuinely failed. Keep
      // the exception: it is "what prevented parsing", the prominent root cause
      // for the quarantine record (more useful than the downstream fallback error).
      astBroken = true;
      materializedTree = null;
      parseError = error;
    }

    // Single character-fallback site for BOTH "clean parse, zero chunks" and
    // "AST threw". On success the file stays indexed (no marker). On failure a
    // genuinely-broken AST (astBroken) is quarantined with the distinct
    // "AST not processed" reason so `doctor --quarantine` explains it; a clean
    // parse of a structureless file lets the raw fallback error propagate
    // (classified as a generic FileParseError downstream).
    try {
      return {
        chunks: this.enforceMaxChunkSize(await this.fallbackChunker.chunk(code, filePath, language)),
        tree: materializedTree,
      };
    } catch (fallbackError) {
      if (!astBroken) throw fallbackError;
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      // Prominent root cause: the parse exception when parse() threw, else a
      // syntax-error descriptor walked from the degraded materialized tree
      // (the rootNode.hasError path produced no exception to carry).
      const parseCause =
        parseError instanceof Error
          ? parseError.message
          : typeof parseError === "string"
            ? parseError
            : parseError !== undefined
              ? `non-Error value thrown during parse (${typeof parseError})`
              : this.describeSyntaxErrors(materializedTree);
      // The parse exception is the more useful root cause than the fallback
      // error; fall back to the fallback error only on the hasError path.
      const cause =
        parseError instanceof Error ? parseError : fallbackError instanceof Error ? fallbackError : undefined;
      throw new FileParseError(
        filePath,
        `${AST_NOT_PROCESSED_REASON}: ${parseCause} (character fallback also failed: ${fallbackDetail})`,
        cause,
      );
    }
  }

  /**
   * Concise syntax-error descriptor for the `rootNode.hasError` quarantine path
   * (no exception was thrown). Walks the already-degraded materialized tree for
   * the first ERROR node and reports its 1-based line; falls back to a generic
   * marker when the tree is gone or carries no ERROR node (e.g. only MISSING
   * nodes). Cheap: only ever runs on the about-to-be-quarantined broken path.
   */
  private describeSyntaxErrors(tree: MaterializedTree | null): string {
    const line = tree ? this.findFirstErrorLine(tree.rootNode) : null;
    return line !== null
      ? `tree-sitter reported a syntax error at line ${line}`
      : "tree-sitter reported syntax errors (rootNode.hasError)";
  }

  /** DFS for the first `type === "ERROR"` node, returning its 1-based start line. */
  private findFirstErrorLine(node: AstNode): number | null {
    if (node.type === "ERROR") return node.startPosition.row + 1;
    for (const child of node.children) {
      const line = this.findFirstErrorLine(child);
      if (line !== null) return line;
    }
    return null;
  }

  /**
   * Oversized node without valid children — split on its statement boundaries.
   * The parts keep the node's identity: `chunkType: "function"` and the node's
   * own symbolId as the base of `#partN`, so the codegraph owner rule and
   * find_symbol both fold them back into the one symbol.
   */
  private chunkOversizedNode(
    node: AstNode,
    parentName: string | undefined,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): void {
    this.emitSplitSymbol(
      node,
      { symbolId: this.buildSymbolId(parentName), name: parentName, chunkType: "function" },
      code,
      filePath,
      language,
      chunks,
    );
  }

  /**
   * Emit an oversized symbol as `#part1..#partN` — one sequence per symbol,
   * numbered once, cut by `AstSymbolSplitter` on statement boundaries with the
   * enclosing context as each part's prefix (bd tea-rags-mcp-y5vx4).
   *
   * `parentSymbolId` is the symbol itself on every part and `parentType` the
   * symbol's own node type: a part's parent IS the symbol it was cut from. The
   * container lineage stays readable from the base id (`Foo#bar` → `Foo`),
   * which is what the codegraph owner rule and the symbol-mass pass already
   * fold on.
   *
   * A MEMBER's parts open with the container hierarchy prefix, exactly as the
   * unsplit member chunk does (bd tea-rags-mcp-jgb5a), so a part's layout is:
   * hierarchy prefix → leading comment (`#part1` only) → the splitter's
   * signature/context prefix → the part's own rows. The prefix is cut out of
   * the splitter's budget, so every part still fits `maxChunkSize`; a prefix
   * taking half the budget or more (pathologically long header rows) is
   * dropped instead, since it would leave the parts no room for code.
   */
  private emitSplitSymbol(
    node: AstNode,
    identity: SplitSymbolIdentity,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): void {
    const rawPrefix = identity.hierarchyPrefix ?? "";
    const hierarchyPrefix = rawPrefix.length * 2 < this.config.maxChunkSize ? rawPrefix : "";
    const splitter =
      hierarchyPrefix === ""
        ? this.symbolSplitter
        : new AstSymbolSplitter(this.config.maxChunkSize - hierarchyPrefix.length);
    const parts = splitter.split(node, code, identity.leadingStartRow);
    const methodLines = node.endPosition.row - node.startPosition.row + 1;
    const parentType = identity.parentType ?? this.unwrapDecoratedDefinition(node).type;
    parts.forEach((part, i) => {
      chunks.push({
        content: `${hierarchyPrefix}${part.content}`,
        startLine: part.startLine,
        endLine: part.endLine,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: identity.chunkType,
          name: identity.name === undefined ? undefined : `${identity.name} (part ${i + 1}/${parts.length})`,
          symbolId: identity.symbolId === undefined ? undefined : `${identity.symbolId}#part${i + 1}`,
          parentSymbolId: identity.symbolId,
          parentType,
          methodLines,
          ...(identity.claimed ? { claimed: true } : {}),
        },
      });
    });
  }

  /**
   * Handle nodes where children should be extracted (classes, modules, large containers).
   * Returns true if the node was handled, false if it should fall through to single-node chunking.
   */
  private async chunkWithChildExtraction(
    node: AstNode,
    langConfig: LanguageConfig,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): Promise<boolean> {
    // bd tea-rags-mcp-kn0vj — a const-object namespace declaration a filter kept
    // as a container carries no `name` field; its name is the namespace's, so
    // its members compose `X.m` exactly as on the 62hzr descent path.
    const parentName =
      this.extractName(node, code, langConfig.nameExtractor) ?? constObjectNamespaceContainerName(node) ?? undefined;
    const parentType = node.type;

    const childNodes = this.findChildChunkableNodes(
      node,
      langConfig.childChunkTypes ?? [],
      langConfig.hooks,
      code,
      filePath,
    );

    // bd tea-rags-mcp-52e8 — `keepShortChildChunkTypes` opts a node type
    // out of the 50-char minimum (Java abstract / interface methods are
    // signature-only and routinely under the floor; without the opt-out
    // their chunks were dropped silently and `find_symbol("Pair#getLeft")`
    // returned []). For all other types the historical floor stands.
    const keepShortSet = new Set<string>(langConfig.keepShortChildChunkTypes ?? []);
    const validChildren = childNodes.filter(
      (c) => keepShortSet.has(c.type) || code.substring(c.startIndex, c.endIndex).length >= 50,
    );

    if (validChildren.length > 0) {
      const containerHeader = this.extractContainerHeader(node, code);
      // Every body chunk is emitted as `${containerHeader}\n${content}` below,
      // so the hook's budget is told about that prefix (bd tea-rags-mcp-pi1cl).
      const ctx = createHookContext(
        node,
        validChildren,
        code,
        { maxChunkSize: this.config.maxChunkSize, bodyChunkPrefixLength: containerHeader.length + 1 },
        filePath,
      );
      for (const hook of langConfig.hooks ?? []) {
        // Hook chain stops as soon as a writer claims this container by
        // populating ctx.bodyChunks. See .claude/rules/chunker-hooks.md.
        if (ctx.bodyChunks.length > 0) break;
        hook.process(ctx);
      }

      await this.processChildren(validChildren, ctx, langConfig, code, filePath, language, parentName, node, chunks, [
        containerHeader,
      ]);

      if (langConfig.alwaysExtractChildren) {
        const hasHookChain = langConfig.hooks && langConfig.hooks.length > 0;
        if (hasHookChain) {
          for (const result of ctx.bodyChunks) {
            const body = this.composeBodyChunkContent([], containerHeader, result.content);
            chunks.push({
              content: body.content,
              startLine: result.startLine,
              endLine: result.endLine,
              metadata: {
                filePath,
                language,
                chunkIndex: chunks.length,
                chunkType: (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
                name: result.name ?? parentName,
                parentSymbolId: result.parentSymbolId ?? parentName,
                parentType: result.parentType ?? parentType,
                symbolId: result.symbolId ?? this.buildSymbolId(parentName),
                lineRanges: result.lineRanges,
                contextPrefix: body.contextPrefix,
              },
            });
          }
        }
        // bd tea-rags-mcp-deoki — the container's own rows no child and no
        // body chunk carries. On the no-hook path this IS the narrow parent
        // chunk of bd tea-rags-mcp-b7k3 (never the full range — children's rows
        // are excluded), now also carrying the rows AFTER the first child.
        this.emitContainerRemainder(
          node,
          validChildren,
          ctx,
          {
            symbolId: this.buildSymbolId(parentName),
            name: parentName,
            parentSymbolId: parentName,
            parentType,
            chunkType: this.getChunkType(node.type),
          },
          [],
          filePath,
          language,
          chunks,
        );
      }
      return true;
    }

    // No valid children found
    const content = code.substring(node.startIndex, node.endIndex);
    const isTooLarge = content.length > this.config.maxChunkSize;
    if (isTooLarge) {
      this.chunkOversizedNode(node, parentName, code, filePath, language, chunks);
      return true;
    }

    return false;
  }

  /**
   * Handle regular single-node chunking (no child extraction).
   */
  private chunkSingleNode(
    node: AstNode,
    langConfig: LanguageConfig,
    index: number,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
    decision: ChunkDecision,
  ): void {
    const content = code.substring(node.startIndex, node.endIndex);

    if (decision.kind === "skip") return;

    // Classifier `emit`: the language provider has ALREADY composed each
    // symbolId — the engine emits one chunk per `EmittedChunk` at the node's
    // own source range, in array order at consecutive indices (`index + i`),
    // flagged `claimed` so the merge pass leaves them intact. Collapses the
    // former JS `chunkSymbols` fan-out (chunkType "function") and the Go
    // method/type branches (refined chunkType) into one capability call.
    // bd tea-rags-mcp-kfzx / z95o / d1f8 / n7x5 / j2b7.
    // An oversized node is split on its statement boundaries here, while the
    // AST is at hand, instead of being line-cut by the `enforceMaxChunkSize`
    // post-pass (bd tea-rags-mcp-y5vx4).
    const oversized = content.trim().length > this.config.maxChunkSize;

    if (decision.kind === "emit") {
      if (oversized) {
        for (const c of decision.chunks) {
          this.emitSplitSymbol(
            node,
            { symbolId: c.symbolId, name: c.name, chunkType: c.chunkType, claimed: true },
            code,
            filePath,
            language,
            chunks,
          );
        }
        return;
      }
      decision.chunks.forEach((c, i) => {
        chunks.push({
          content: content.trim(),
          startLine: node.startPosition.row + 1,
          endLine: this.computeEndLine(node),
          metadata: {
            filePath,
            language,
            chunkIndex: index + i,
            chunkType: c.chunkType,
            name: c.name,
            symbolId: c.symbolId,
            claimed: true,
            methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
          },
        });
      });
      return;
    }

    // passthrough — generic shaping (the floor was already applied in the chunk() loop).
    // A kept const-object namespace whose members all fell under the size floor
    // reaches here whole, named by its namespace (bd tea-rags-mcp-kn0vj).
    const nodeName = this.extractName(node, code) ?? constObjectNamespaceContainerName(node) ?? undefined;
    // bd tea-rags-mcp-62hzr — a member of a const-object NAMESPACE
    // (`export const X = { m() {} }`) whose declaration the language filter did
    // not keep as a container (bd tea-rags-mcp-kn0vj) reaches this path as a
    // TOP-LEVEL chunkable `method_definition`: `findChunkableNodes` descends
    // through the declaration and the member never acquires a parent. Emitting
    // the bare `m` broke lockstep with `cg_symbols`, which
    // holds `X.m` since bd tea-rags-mcp-2jhwk — `get_callers` on an id copied
    // out of a search hit returned []. The separator is the namespace one, not
    // the instance `#`: an object-literal method binds no instance.
    const namespaceOwner = constObjectNamespaceOwner(node);
    // bd tea-rags-mcp-lyo4p — a member of a class EXPRESSION or of a class
    // nested in an anonymous scope reaches this path too, with no container to
    // name its class. The walker names that class, so the id carries it.
    // bd tea-rags-mcp-39xca.19 — so does a member of the literal a
    // declarator-bound factory returns (`const make = () => ({ m() {} })`):
    // the walker names the declarator, `classifyMethod` supplies the `#`.
    const classOwner = this.composeParentSymbol(
      undefined,
      [...enclosingClassScopeNames(node, null), ...enclosingFactoryScopeNames(node, null)],
      langConfig.scopeSeparator,
    );
    // A `statement` decision (bd tea-rags-mcp-lyo4p): the extracted name is
    // something the statement USES, so it labels the chunk and owns no id.
    let symbolId: string | undefined;
    if (decision.kind === "statement") {
      symbolId = undefined;
    } else if (namespaceOwner && nodeName) {
      symbolId = this.symbolIds.compose(namespaceOwner, nodeName, { scopeSeparator: langConfig.scopeSeparator });
    } else {
      symbolId = this.buildSymbolId(nodeName, classOwner, classifyMethod(node), langConfig.scopeSeparator);
    }
    const parentSymbolId = namespaceOwner ?? classOwner;
    if (oversized) {
      this.emitSplitSymbol(
        node,
        { symbolId, name: nodeName, chunkType: this.getChunkType(node.type) },
        code,
        filePath,
        language,
        chunks,
      );
      return;
    }
    chunks.push({
      content: content.trim(),
      startLine: node.startPosition.row + 1,
      endLine: this.computeEndLine(node),
      metadata: {
        filePath,
        language,
        chunkIndex: index,
        chunkType: this.getChunkType(node.type),
        name: nodeName,
        parentSymbolId,
        symbolId,
        methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
      },
    });
  }

  /**
   * Merge adjacent small top-level chunks into combined block chunks.
   * Language-agnostic post-processing step that reduces search noise from
   * many tiny declarations (type aliases, small interfaces) per file.
   */
  private mergeSmallChunks(chunks: CodeChunk[]): CodeChunk[] {
    if (chunks.length < 2) return chunks;

    const result: CodeChunk[] = [];
    let mergeGroup: CodeChunk[] = [];

    const isMergeable = (chunk: CodeChunk): boolean => {
      const lines = chunk.endLine - chunk.startLine;
      // Chunks emitted by a language classifier carry an explicit symbolId that
      // merging would destroy (e.g. Go named type aliases) — never merge them.
      // Passthrough chunks merge per the rule below (TS small type aliases DO
      // merge even though they have a symbolId).
      if (chunk.metadata.claimed) {
        return false;
      }
      return (
        lines <= TreeSitterChunker.MERGE_THRESHOLD &&
        !chunk.metadata.parentSymbolId &&
        TreeSitterChunker.MERGEABLE_TYPES.has(chunk.metadata.chunkType ?? "")
      );
    };

    const flushGroup = (): void => {
      if (mergeGroup.length >= 2) {
        const content = mergeGroup.map((c) => c.content).join("\n\n");
        if (content.length <= this.config.maxChunkSize) {
          result.push({
            content,
            startLine: mergeGroup[0].startLine,
            endLine: mergeGroup[mergeGroup.length - 1].endLine,
            metadata: {
              filePath: mergeGroup[0].metadata.filePath,
              language: mergeGroup[0].metadata.language,
              chunkIndex: mergeGroup[0].metadata.chunkIndex,
              chunkType: "block",
              name: `${mergeGroup[0].metadata.name ?? "declarations"}...`,
            },
          });
          mergeGroup = [];
          return;
        }
      }
      // Single chunk or oversized merge -> emit individually
      result.push(...mergeGroup);
      mergeGroup = [];
    };

    for (const chunk of chunks) {
      if (isMergeable(chunk)) {
        if (mergeGroup.length > 0) {
          const lastEnd = mergeGroup[mergeGroup.length - 1].endLine;
          const gap = chunk.startLine - lastEnd;
          if (gap > TreeSitterChunker.MERGE_GAP) {
            flushGroup();
          }
        }
        mergeGroup.push(chunk);
      } else {
        flushGroup();
        result.push(chunk);
      }
    }
    flushGroup();

    // Re-index chunkIndex
    for (let i = 0; i < result.length; i++) {
      result[i].metadata.chunkIndex = i;
    }

    return result;
  }

  /**
   * Hard cap post-process: split any chunk whose content exceeds maxChunkSize
   * into N parts that each fit. Splits on line boundaries when possible to
   * keep code readable; falls back to character-level splits for single-line
   * monsters (minified bundles, generated code).
   *
   * Naming convention for the parts:
   *  - symbolId  -> `${original}#part${i+1}` so navigation and find_symbol stay
   *    deterministic; original symbolId becomes parentSymbolId.
   *  - name      -> `${original} (part i/N)` for human-readable labels.
   *
   * Doc chunks (doc:hash symbolId) are split too — `assignNavigationAndDocSymbolId`
   * later re-derives doc symbolIds from chunkIndex, which we re-number here
   * so each part gets its own unique hash.
   */
  private enforceMaxChunkSize(chunks: CodeChunk[]): CodeChunk[] {
    const max = this.config.maxChunkSize;
    // Pass 1 — cut every oversized chunk and count the parts each symbolId will
    // carry, so numbering runs ONCE per symbol across all its oversized chunks
    // (bd tea-rags-mcp-y5vx4: numbering restarted per chunk, and two oversized
    // windows of one symbol both produced `#part1`).
    const segmentsOf = new Map<CodeChunk, ContentSegment[]>();
    const partTotals = new Map<string, number>();
    for (const chunk of chunks) {
      if (chunk.content.length <= max) continue;
      const segments = this.segmentUnderContextPrefix(chunk, max);
      segmentsOf.set(chunk, segments);
      const key = chunk.metadata.symbolId ?? "";
      partTotals.set(key, (partTotals.get(key) ?? 0) + segments.length);
    }

    const partCursor = new Map<string, number>();
    const result: CodeChunk[] = [];
    for (const chunk of chunks) {
      const segments = segmentsOf.get(chunk);
      if (!segments) {
        result.push(chunk);
        continue;
      }
      const key = chunk.metadata.symbolId ?? "";
      const firstPart = (partCursor.get(key) ?? 0) + 1;
      partCursor.set(key, firstPart + segments.length - 1);
      result.push(...this.splitOversizedChunk(chunk, segments, firstPart, partTotals.get(key) ?? segments.length));
    }
    for (let i = 0; i < result.length; i++) {
      result[i].metadata.chunkIndex = i;
      delete result[i].metadata.contextPrefix;
    }
    return result;
  }

  /**
   * Cut an oversized chunk into line segments. A chunk that names its container
   * through a `contextPrefix` (a hook body chunk: hierarchy + container header)
   * gets that prefix on EVERY segment, cut out of each segment's budget — a bare
   * line cut left `#part2+` naming nothing (bd tea-rags-mcp-j4jrn: an RSpec
   * setup chunk, a Ruby body group with a row wider than its budget). Segment
   * line indices stay indices into the chunk's content, so the line mapping of
   * `splitOversizedChunk` reads them unchanged. A prefix taking half the budget
   * or more is not repeated, as in `emitSplitSymbol`.
   */
  private segmentUnderContextPrefix(chunk: CodeChunk, max: number): ContentSegment[] {
    const prefix = chunk.metadata.contextPrefix;
    if (!prefix || prefix.length * 2 >= max || !chunk.content.startsWith(prefix)) {
      return this.splitContentIntoSegments(chunk.content, max);
    }
    const prefixLines = prefix.split("\n").length - 1;
    return this.splitContentIntoSegments(chunk.content.slice(prefix.length), max - prefix.length).map((segment) => ({
      text: `${prefix}${segment.text}`,
      firstLine: segment.firstLine + prefixLines,
      lastLine: segment.lastLine + prefixLines,
    }));
  }

  /**
   * One oversized chunk → its parts, numbered from `firstPart` out of `partTotal`
   * for the symbol. Line ranges are exact: content lines past the chunk's own
   * line span are a prefix (hierarchy headers, a comment prefix), so the first
   * `prefixLines` content lines map to no source line and every later line maps
   * 1:1 onto `startLine..endLine`.
   */
  private splitOversizedChunk(
    chunk: CodeChunk,
    segments: ContentSegment[],
    firstPart: number,
    partTotal: number,
  ): CodeChunk[] {
    const originalSymbolId = chunk.metadata.symbolId;
    const originalName = chunk.metadata.name ?? "chunk";
    const parentSymbolId = originalSymbolId ?? chunk.metadata.parentSymbolId;
    const contentLines = chunk.content.split("\n").length;
    const prefixLines = Math.max(0, contentLines - (chunk.endLine - chunk.startLine + 1));
    const sourceLine = (contentLine: number): number =>
      Math.min(chunk.endLine, chunk.startLine + Math.max(0, contentLine - prefixLines));

    return segments.map((segment, i) => {
      const part = firstPart + i;
      return {
        content: segment.text,
        startLine: sourceLine(segment.firstLine),
        endLine: sourceLine(segment.lastLine),
        metadata: {
          ...chunk.metadata,
          chunkIndex: chunk.metadata.chunkIndex,
          name: `${originalName} (part ${part}/${partTotal})`,
          symbolId: originalSymbolId ? `${originalSymbolId}#part${part}` : undefined,
          parentSymbolId,
          methodLines: chunk.metadata.methodLines ?? segment.lastLine - segment.firstLine + 1,
        },
      };
    });
  }

  /**
   * Split text into segments each <= max chars on line boundaries. A single
   * line wider than max is character-sliced — the only mid-line cut.
   * `firstLine` / `lastLine` are 0-based content line indices.
   */
  private splitContentIntoSegments(content: string, max: number): ContentSegment[] {
    const lines = content.split("\n");
    const segments: ContentSegment[] = [];
    let current: ContentSegment | undefined;
    lines.forEach((line, index) => {
      if (line.length > max) {
        if (current) segments.push(current);
        current = undefined;
        for (let i = 0; i < line.length; i += max) {
          segments.push({ text: line.slice(i, i + max), firstLine: index, lastLine: index });
        }
        return;
      }
      if (current && current.text.length + 1 + line.length <= max) {
        current.text = `${current.text}\n${line}`;
        current.lastLine = index;
        return;
      }
      if (current) segments.push(current);
      current = { text: line, firstLine: index, lastLine: index };
    });
    if (current) segments.push(current);
    return segments;
  }

  supportsLanguage(language: string): boolean {
    return this.languages.supported().includes(language);
  }

  getStrategyName(): string {
    return "tree-sitter";
  }

  /**
   * Get list of supported languages
   */
  getSupportedLanguages(): string[] {
    return this.languages.supported();
  }

  /**
   * Preload specific language parsers (optional optimization)
   * Call this if you know which languages will be used
   */
  async preloadLanguages(languages: string[]): Promise<void> {
    await Promise.all(languages.map(async (lang) => this.getLanguageConfig(lang)));
  }

  /**
   * Get stats about loaded parsers
   */
  getLoadedParsers(): { loaded: string[]; available: string[] } {
    return {
      loaded: Array.from(this.parserCache.keys()),
      available: this.languages.supported(),
    };
  }

  /**
   * Find all chunkable nodes in the AST
   */
  /**
   * Extract the opening line of a container node (e.g., "RSpec.describe User do").
   * Used to build hierarchy context for nested chunks.
   */
  private extractContainerHeader(node: AstNode, code: string): string {
    const lines = code.substring(node.startIndex, node.endIndex).split("\n");
    return lines[this.containerHeaderRow(node) - node.startPosition.row].trim();
  }

  /**
   * 0-based row that NAMES the container: the row its `name` starts on, not
   * its first row. A declaration opening with attribute / decorator /
   * annotation rows (`@NSApplicationMain`, `@dataclass`, `@Component({...})`)
   * took the attribute as its header, so no member chunk named the class (bd
   * tea-rags-mcp-j4jrn). A container with no `name` field (an RSpec
   * `describe` call, a const-object namespace) keeps its first row.
   */
  private containerHeaderRow(node: AstNode): number {
    const nameRow = this.unwrapDecoratedDefinition(node).childForFieldName("name")?.startPosition.row;
    return nameRow !== undefined && nameRow > node.startPosition.row && nameRow <= node.endPosition.row
      ? nameRow
      : node.startPosition.row;
  }

  /**
   * Build hierarchy prefix string from container headers.
   * Each level is indented to show nesting.
   */
  private buildHierarchyPrefix(headers: string[]): string {
    if (headers.length === 0) return "";
    return `${headers.map((h, i) => "  ".repeat(i) + h).join("\n")}\n`;
  }

  /**
   * A hook's body chunk as emitted, under its prefix: the enclosing hierarchy,
   * then the container's own header — unless the chunk already opens with the
   * container's first row. A class-body hook writes that row verbatim
   * (`export class X extends Y {`, `class Foo < Bar`), and prefixing the
   * engine's `class X extends Y {` on top of it named the container twice in
   * every such chunk (bd tea-rags-mcp-4i6ab). The hook's budget reserves the
   * full prefix either way (`bodyChunkPrefixLength`), so dropping the header
   * can only shorten a chunk.
   */
  private composeBodyChunkContent(
    hierarchyHeaders: string[],
    containerHeader: string,
    content: string,
  ): { content: string; contextPrefix: string } {
    const firstRow = content.split("\n", 1)[0];
    const trimmedFirstRow = firstRow.trim();
    const carriesHeader = trimmedFirstRow === containerHeader || trimmedFirstRow.endsWith(` ${containerHeader}`);
    const prefix = `${this.buildHierarchyPrefix(hierarchyHeaders)}${carriesHeader ? "" : `${containerHeader}\n`}`;
    // The rows naming the container — the engine's prefix, plus the hook's own
    // header row when it wrote one. The `enforceMaxChunkSize` post-pass repeats
    // them on every part it cuts from this chunk (bd tea-rags-mcp-j4jrn).
    return {
      content: `${prefix}${content}`,
      contextPrefix: carriesHeader ? `${prefix}${firstRow}\n` : prefix,
    };
  }

  /**
   * Process child nodes of a container, recursing into nested containers.
   * Handles the child extraction loop with support for arbitrary nesting depth.
   *
   * Each child takes exactly one of three exits — oversized (character
   * fallback), nested container (recurse), or leaf (emit) — so the loop stays a
   * routing decision and each exit owns its own emission rules.
   */
  private async processChildren(
    validChildren: AstNode[],
    ctx: HookContext,
    langConfig: LanguageConfig,
    code: string,
    filePath: string,
    language: string,
    parentName: string | undefined,
    container: AstNode,
    chunks: CodeChunk[],
    hierarchyHeaders: string[] = [],
  ): Promise<void> {
    // If hook chain has taken over chunking (e.g., RSpec scope chunker),
    // skip child emission — all chunks are in ctx.bodyChunks
    if (ctx.skipChildren) return;

    const pass: ChildChunkEmissionPass = {
      ctx,
      langConfig,
      code,
      filePath,
      language,
      parentName,
      parentType: container.type,
      container,
      chunks,
      hierarchyHeaders,
      // bd tea-rags-mcp-a466 — occurrence counting is scoped to THIS pass, so
      // sibling overloads collide (and get `~N`) while the same name under a
      // different container does not.
      overloads: new SymbolIdDisambiguator(langConfig.disambiguateOverloads === true),
    };

    for (let ci = 0; ci < validChildren.length; ci++) {
      const childNode = validChildren[ci];
      const childContent = code.substring(childNode.startIndex, childNode.endIndex);

      if (childContent.length > this.config.maxChunkSize) {
        this.emitOversizedChild(childNode, ci, pass);
        continue;
      }

      // Check if child is itself a container (e.g., nested describe/context)
      const grandChildren = this.findChildChunkableNodes(
        childNode,
        langConfig.childChunkTypes ?? [],
        langConfig.hooks,
        code,
        filePath,
      );
      const validGrandChildren = grandChildren.filter((c) => code.substring(c.startIndex, c.endIndex).length >= 50);

      if (
        validGrandChildren.length > 0 &&
        langConfig.alwaysExtractChildren &&
        this.canRecurseAsContainer(childNode, langConfig)
      ) {
        await this.emitNestedContainer(childNode, ci, validGrandChildren, pass);
        continue;
      }

      this.emitLeafChild(childNode, ci, childContent, pass);
    }
  }

  /**
   * bd tea-rags-mcp-07fr — Recurse-as-container is correct only when the child
   * is itself a SCOPE container (class / module). If a class method
   * (`def route`) contains an inner function (`def decorator`), recursing would
   * emit ONLY the inner function and shadow the outer method. The outer method
   * must be emitted as a leaf chunk so `find_symbol("Scaffold#route")`
   * resolves. The grandchildren (inner defs) are intentionally NOT chunked
   * separately — decorator-factories and helper closures rarely need standalone
   * search hits.
   */
  private canRecurseAsContainer(childNode: AstNode, langConfig: LanguageConfig): boolean {
    const isScopeContainerChild = langConfig.scopeContainerTypes?.includes(childNode.type) ?? false;
    const childIsRubyHookContainer = (langConfig.hooks?.length ?? 0) > 0;
    return isScopeContainerChild || childIsRubyHookContainer;
  }

  /**
   * Child too large for one chunk — split it on its statement boundaries.
   *
   * The parts are numbered under the composed method symbolId
   * (`Foo#__init__#part1..N`) and keep the method's chunkType. Before bd
   * tea-rags-mcp-5xie the raw fallback chunks carried `symbolId: undefined` /
   * `chunkType: "block"`, so `find_symbol("Flask#__init__")` came up empty even
   * though cg_symbols had the entry; the parts still resolve under that id. See
   * `.claude/rules/symbolid-convention.md` and oversized-symbol-split.test.ts.
   */
  private emitOversizedChild(childNode: AstNode, ci: number, pass: ChildChunkEmissionPass): void {
    const { langConfig, code, filePath, language, parentName, chunks } = pass;
    const semanticNode = this.unwrapDecoratedDefinition(childNode);
    const childName = this.extractName(semanticNode, code, langConfig.nameExtractor);
    const methodKind = classifyMethod(semanticNode);
    const intermediateScopes = [
      ...this.collectIntermediateScopes(childNode, langConfig, code),
      ...enclosingClassScopeNames(semanticNode, pass.container),
      ...enclosingFactoryScopeNames(semanticNode, pass.container),
    ];
    const effectiveParent = this.composeParentSymbol(parentName, intermediateScopes, langConfig.scopeSeparator);
    // bd tea-rags-mcp-a466 — disambiguate overloads BEFORE deciding
    // the chunk's symbolId so oversized-method splits inherit the
    // already-suffixed id (each split shares the composed method id;
    // see bd tea-rags-mcp-5xie invariant). Without this, two oversized
    // overloads would collapse into the same symbolId across parts.
    const methodSymbolId = pass.overloads.disambiguate(
      this.buildSymbolId(childName, effectiveParent, methodKind, langConfig.scopeSeparator),
    );
    // A hook-supplied label survives the split, exactly as the composed
    // symbolId does — otherwise a long XCTest case's parts would carry
    // `chunkType: "function"` while its short siblings carry `"test"`.
    const methodChunkType = pass.ctx.methodChunkTypes.get(ci) ?? this.getChunkType(semanticNode.type);
    // bd tea-rags-mcp-y5vx4 — the parts are `${methodSymbolId}#partN`, one
    // sequence per method, cut on statement boundaries. They no longer share
    // the bare method id (5xie): the codegraph owner rule and find_symbol fold
    // `#partN` back onto the method. The class lineage cpbv protected stays
    // readable from the method id itself, and parentSymbolId (= the method) is
    // no longer a self-loop because no part carries the bare id.
    this.emitSplitSymbol(
      childNode,
      {
        symbolId: methodSymbolId,
        name: childName,
        chunkType: methodChunkType,
        leadingStartRow: this.leadingCommentStartRow(pass.ctx, ci),
        hierarchyPrefix: this.buildHierarchyPrefix(pass.hierarchyHeaders),
      },
      code,
      filePath,
      language,
      chunks,
    );
  }

  /**
   * Child is itself a container (nested describe/context, nested class) —
   * recurse into its grandchildren, then emit whatever the hook chain produced
   * for the container's own body.
   */
  private async emitNestedContainer(
    childNode: AstNode,
    ci: number,
    validGrandChildren: AstNode[],
    pass: ChildChunkEmissionPass,
  ): Promise<void> {
    const { langConfig, code, filePath, language, parentName, parentType, chunks, hierarchyHeaders } = pass;
    const childName = this.extractName(childNode, code, langConfig.nameExtractor);
    const childHeader = this.extractContainerHeader(childNode, code);
    // The prefix every body chunk of this container is emitted under (below),
    // reserved in the hook's budget (bd tea-rags-mcp-pi1cl).
    const bodyChunkPrefix =
      hierarchyHeaders.length > 0 ? `${this.buildHierarchyPrefix(hierarchyHeaders)}${childHeader}\n` : "";
    const childCtx = createHookContext(
      childNode,
      validGrandChildren,
      code,
      {
        maxChunkSize: this.config.maxChunkSize,
        bodyChunkPrefixLength: bodyChunkPrefix.length,
      },
      filePath,
    );
    for (const hook of langConfig.hooks ?? []) {
      if (childCtx.bodyChunks.length > 0) break;
      hook.process(childCtx);
    }

    // The recursed container becomes the PARENT of everything below it, so its
    // own segment obeys the same tri-state rule its leaf siblings do — an
    // instance method joins its class with `#`, a static one with `.`, and a
    // non-method scope container with the language's scopeSeparator.
    //
    // bd tea-rags-mcp-cv4k1 — this used to fold the chain through
    // `buildParentPath`, which joined every segment with `scopeSeparator`
    // unconditionally. That discarded exactly what bd tea-rags-mcp-pdv8m had
    // just taught the LEAF composer: `install({ handle() {} })` inside
    // `Registry#register` composed as `Registry.register.handle` while the
    // codegraph walker composed `Registry#register.handle`, so the parent
    // segment named a symbol no cg_symbols row carries. `classifyMethod`
    // returns null for every scope container that is not a method
    // (`class_definition`, `module`, `impl_item`), so namespace folds are
    // unchanged. `bd tea-rags-mcp-ksb8` still applies: the separator comes from
    // the composer, never a hand-written ` > ` join.
    //
    // An anonymous container keeps its parent's id rather than dropping to
    // `undefined` — the chain must not lose the levels already composed.
    const fullParentName = childName
      ? this.buildSymbolId(childName, parentName, classifyMethod(childNode), langConfig.scopeSeparator)
      : parentName;

    await this.processChildren(
      validGrandChildren,
      childCtx,
      langConfig,
      code,
      filePath,
      language,
      fullParentName,
      childNode,
      chunks,
      [...hierarchyHeaders, childHeader],
    );

    // Body chunks from hook chain for this nested container
    for (const result of childCtx.bodyChunks) {
      const body =
        hierarchyHeaders.length > 0
          ? this.composeBodyChunkContent(hierarchyHeaders, childHeader, result.content)
          : { content: result.content, contextPrefix: undefined };
      chunks.push({
        content: body.content,
        startLine: result.startLine,
        endLine: result.endLine,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
          name: result.name ?? childName,
          parentSymbolId: result.parentSymbolId ?? fullParentName ?? parentName,
          parentType: result.parentType ?? parentType,
          symbolId: result.symbolId ?? this.buildSymbolId(childName),
          lineRanges: result.lineRanges,
          ...(body.contextPrefix === undefined ? {} : { contextPrefix: body.contextPrefix }),
        },
      });
    }

    // bd tea-rags-mcp-deoki — the recursed container's own rows. An anonymous
    // container has no id of its own (`fullParentName` fell back to the OUTER
    // container's id above), so its remainder stays anonymous rather than
    // borrowing — and duplicating — the enclosing container's id.
    this.emitContainerRemainder(
      childNode,
      validGrandChildren,
      childCtx,
      {
        symbolId: childName ? fullParentName : undefined,
        name: childName,
        parentSymbolId: parentName,
        parentType,
        chunkType: this.getChunkType(childNode.type),
      },
      hierarchyHeaders,
      filePath,
      language,
      chunks,
      // bd tea-rags-mcp-6wy02 — the comment the OUTER container's capture hook
      // attached to this child is in the outer `excludedRows`, i.e. promised
      // to this child's chunk; the recursed child's own chunk is its remainder.
      this.leadingCommentStartRow(pass.ctx, ci),
    );
  }

  /**
   * First row (0-based) of the comment block a comment-capture hook attached to
   * child `ci`, or `undefined` when it attached none. Those rows are in the
   * container's `excludedRows` — promised to the child's chunk — so every
   * emission path of the child must carry them, not only the leaf path that
   * reads `methodPrefixes` (bd tea-rags-mcp-u7tjf / 6wy02).
   */
  private leadingCommentStartRow(ctx: HookContext, ci: number): number | undefined {
    if (!ctx.methodPrefixes.has(ci)) return undefined;
    const startLine = ctx.methodStartLines.get(ci);
    return startLine === undefined ? undefined : startLine - 1;
  }

  /**
   * Leaf child — emit as a single chunk with hierarchy context.
   *
   * `ci` is the child's index within the pass: the hook chain addresses its
   * per-method prefix / start-line overrides by that index.
   */
  private emitLeafChild(childNode: AstNode, ci: number, childContent: string, pass: ChildChunkEmissionPass): void {
    const { ctx, langConfig, code, filePath, language, parentName, parentType, chunks, hierarchyHeaders } = pass;
    let finalContent = childContent.trim();
    let startLine = childNode.startPosition.row + 1;

    const prefix = ctx.methodPrefixes.get(ci);
    if (prefix) {
      finalContent = `${prefix}\n${finalContent}`;
    }
    const overrideStart = ctx.methodStartLines.get(ci);
    if (overrideStart !== undefined) {
      startLine = overrideStart;
    }

    // Prepend hierarchy headers for context (e.g., describe > context > context)
    if (hierarchyHeaders.length > 0) {
      const hierarchyPrefix = this.buildHierarchyPrefix(hierarchyHeaders);
      finalContent = `${hierarchyPrefix}${finalContent}`;
    }

    // bd tea-rags-mcp-jgb5a — a member that fits the budget on its own but not
    // under its hierarchy prefix and leading comment is split on its statement
    // boundaries like any oversized member, so every part carries the prefix.
    // Left as one chunk, the `enforceMaxChunkSize` post-pass line-cut it, and
    // every part after the first named neither its class nor its signature.
    if (finalContent.length > this.config.maxChunkSize) {
      this.emitOversizedChild(childNode, ci, pass);
      return;
    }

    // Python `decorated_definition` wraps a `function_definition` whose
    // decorators (@classmethod / @staticmethod) drive the instance vs
    // class-method classification. The outer wrapper has no `name` field
    // and `classifyMethod` only branches on the inner type, so name
    // extraction and static detection must read the inner node — but
    // chunk content/range stays on the outer wrapper so the decorator
    // remains visible. See `.claude/rules/symbolid-convention.md`.
    const semanticNode = this.unwrapDecoratedDefinition(childNode);
    const childName = this.extractName(semanticNode, code, langConfig.nameExtractor);
    // Universal `#` (instance) vs `.` (class/static) vs scope separator
    // (namespace member, e.g. a `method_definition` in an object literal) —
    // single source of truth in `infra/symbolid`. See
    // `.claude/rules/symbolid-convention.md` and bd tea-rags-mcp-pdv8m.
    const methodKind = classifyMethod(semanticNode);
    // Accumulate intermediate scope-container ancestor names between
    // the outer container and the leaf (Ruby: nested `module`/`class`).
    // Without this, the leaf's parentSymbolId stays at the OUTERMOST
    // container's name and diverges from the codegraph form
    // (bd tea-rags-mcp-bdvm). When `scopeContainerTypes` is unset, the
    // returned list is empty and behaviour is unchanged.
    //
    // bd tea-rags-mcp-lyo4p — the same gap for a class member found below a
    // class the container does not name (`function f() { class C { m() {} } }`
    // was `f#m`, the walker's `f.C#m`): `enclosingClassScopeNames` supplies
    // those classes. Disjoint from the Ruby-style chain above by node type.
    // bd tea-rags-mcp-39xca.19 — and the declarator-bound factory whose returned
    // literal declares the member (`Store#build.make#read`), which is never a
    // container of its own; it sits below every such class, so it goes last.
    const intermediateScopes = [
      ...this.collectIntermediateScopes(childNode, langConfig, code),
      ...enclosingClassScopeNames(semanticNode, pass.container),
      ...enclosingFactoryScopeNames(semanticNode, pass.container),
    ];
    const effectiveParent = this.composeParentSymbol(parentName, intermediateScopes, langConfig.scopeSeparator);
    // bd tea-rags-mcp-a466 — disambiguate per-overload. The first occurrence
    // under a given (parent, name) keeps its symbolId; subsequent occurrences
    // get a `~N` suffix.
    const symbolId = pass.overloads.disambiguate(
      this.buildSymbolId(childName, effectiveParent, methodKind, langConfig.scopeSeparator),
    );
    chunks.push({
      content: finalContent,
      startLine,
      endLine: this.computeEndLine(childNode),
      metadata: {
        filePath,
        language,
        chunkIndex: chunks.length,
        // A hook may relabel a child whose SHAPE the engine already got right —
        // Swift's XCTest cases and swift-testing `@Test` functions are ordinary
        // methods that must land on `test` / `test_setup`. The engine keeps
        // composing the symbolId; only the label is delegated.
        chunkType: ctx.methodChunkTypes.get(ci) ?? this.getChunkType(semanticNode.type),
        name: childName,
        parentSymbolId: effectiveParent,
        parentType,
        symbolId,
        methodLines: this.computeEndLine(childNode) - (childNode.startPosition.row + 1),
      },
    });
  }

  /**
   * Walk up from `leafNode` collecting names of intermediate scope
   * containers (Ruby: `module A; module B; class C; def foo`) until the
   * walk hits a node that is itself a chunkable container (the outer
   * `parentName` already represents that level).
   *
   * Returns the chain ordered outermost-first WITHIN the intermediate
   * range, e.g. for `module A; module B; class C; def foo` invoked on
   * the `def foo` leaf when the outer container is `module A`, returns
   * `["B", "C"]`. The leaf's own name is NOT included.
   *
   * When `scopeContainerTypes` is unset on the language config, the
   * function bails out with `[]` — the existing single-level behaviour.
   */
  private collectIntermediateScopes(leafNode: AstNode, langConfig: LanguageConfig, code: string): string[] {
    const scopeTypes = langConfig.scopeContainerTypes;
    if (!scopeTypes || scopeTypes.length === 0) return [];
    const chain: string[] = [];
    let p = leafNode.parent;
    while (p) {
      // Stop when we hit any node listed in chunkableTypes — that level
      // is already represented by the outer `parentName`. We must not
      // continue past it or we'd duplicate the outer container's name.
      if (langConfig.chunkableTypes.includes(p.type) && !scopeTypes.includes(p.type)) {
        break;
      }
      if (scopeTypes.includes(p.type)) {
        const name = this.extractName(p, code, langConfig.nameExtractor);
        if (name) chain.push(name);
      }
      p = p.parent;
    }
    // The walk produced names innermost-first; reverse to get
    // outermost-first ordering for the symbolId join.
    chain.reverse();
    // Drop the outermost entry — that's the level already named by
    // `parentName` in the caller. Without this, `module A; def foo`
    // would emit parentName "A" AND chain ["A"], yielding "A::A#foo".
    if (chain.length > 0) chain.shift();
    return chain;
  }

  /**
   * Compose the effective parent symbolId from the outer container name
   * (`parentName`) and the chain of intermediate scope-container names.
   * Joins with `scopeSeparator` (defaults to `"."` when unset to match
   * the codegraph's default for `.` languages).
   */
  private composeParentSymbol(
    parentName: string | undefined,
    intermediateScopes: string[],
    scopeSeparator?: string,
  ): string | undefined {
    const segments = [...(parentName ? [parentName] : []), ...intermediateScopes];
    if (segments.length === 0) return undefined;
    // Fold the scope chain through the injected composer using the namespace
    // separator (`scopeSeparator`), NOT the `#`/`.` method rule. compose("", s)
    // returns `s` (empty-prefix branch), compose(acc, s, {scopeSeparator})
    // joins `acc<sep>s` — reproduces the historical `segments.join(sep ?? ".")`.
    return segments.reduce((acc, segment) => this.symbolIds.compose(acc, segment, { scopeSeparator }), "");
  }

  private findChunkableNodes(
    node: AstNode,
    chunkableTypes: string[],
    hooks?: ChunkingHook[],
    code?: string,
    filePath?: string,
  ): AstNode[] {
    const nodes: AstNode[] = [];

    const traverse = (n: AstNode) => {
      if (chunkableTypes.includes(n.type)) {
        // Consult hooks for filtering (e.g., RSpec filter rejects non-DSL call nodes)
        if (hooks && code && filePath) {
          const verdict = this.consultFilterHooks(hooks, n, code, filePath);
          if (verdict === false) {
            for (const child of n.children) traverse(child);
            return;
          }
        }
        nodes.push(n);
        // Don't traverse children of chunkable nodes to avoid nested chunks
        return;
      }

      for (const child of n.children) {
        traverse(child);
      }
    };

    traverse(node);
    return nodes;
  }

  /**
   * Find chunkable child nodes inside a parent node (e.g., methods inside a class).
   * Unlike findChunkableNodes, this DOES traverse into the parent's children
   * even if the parent is a chunkable type.
   */
  private findChildChunkableNodes(
    parentNode: AstNode,
    childChunkTypes: string[],
    hooks?: ChunkingHook[],
    code?: string,
    filePath?: string,
  ): AstNode[] {
    const nodes: AstNode[] = [];

    const traverse = (n: AstNode) => {
      // Skip the parent node itself
      if (n === parentNode) {
        for (const child of n.children) {
          traverse(child);
        }
        return;
      }

      if (childChunkTypes.includes(n.type)) {
        // Consult hooks for filtering
        if (hooks && code && filePath) {
          const verdict = this.consultFilterHooks(hooks, n, code, filePath);
          if (verdict === false) {
            for (const child of n.children) traverse(child);
            return;
          }
        }
        nodes.push(n);
        // Don't traverse into this node's children
        return;
      }

      for (const child of n.children) {
        traverse(child);
      }
    };

    traverse(parentNode);
    return nodes;
  }

  /**
   * Emit the container's REMAINDER — its own rows that no extracted child, no
   * hook body chunk, and no captured comment carries (bd tea-rags-mcp-deoki).
   *
   * Before this, a container whose children were extracted lost every row the
   * children did not cover: a Python function's statements after a nested
   * `def`, class attributes declared between methods, and — on the hook path —
   * a TS/JS factory's own statements around the object literal it returns
   * (the class-body hook serves class bodies only). One remainder chunk per
   * container carries them: non-contiguous rows via `lineRanges`, split into
   * `${symbolId}#partN` windows when oversized.
   *
   * Invariants it keeps:
   *   - bd tea-rags-mcp-b7k3 — the container chunk stays NARROW. A child's rows
   *     are never in it, so it is never the full container range and never
   *     duplicates a method body. On the no-hook path it REPLACES the old
   *     narrow parent (rows above the first child) under the same id; it adds
   *     no second chunk.
   *   - One chunk per id. A container whose hook already wrote body chunks
   *     carries the container id there, so the remainder stays out.
   *   - The claim invariant (`.claude/rules/chunker-hooks.md`): a hook that sets
   *     `skipChildren` claimed the WHOLE container — test-scope chunkers decide
   *     themselves where setup rows go (inside example content, never in a
   *     range) — so the engine adds nothing to a claimed container.
   *   - bd tea-rags-mcp-07fr — no new recursion: rows of every valid child,
   *     leaf or recursed, count as covered here; a recursed child emits its
   *     own remainder from `emitNestedContainer`.
   *   - No code-free chunk: a remainder that is only the header line (plus
   *     closing punctuation) is dropped — every member chunk already carries
   *     that header as its hierarchy prefix — and the 50-char floor is measured
   *     on the substantive rows (`planContainerRemainder`).
   */
  private emitContainerRemainder(
    containerNode: AstNode,
    validChildren: AstNode[],
    ctx: HookContext,
    identity: ContainerRemainderIdentity,
    hierarchyHeaders: string[],
    filePath: string,
    language: string,
    chunks: CodeChunk[],
    leadingStartRow?: number,
  ): void {
    if (ctx.skipChildren || ctx.bodyChunks.length > 0) return;

    const coveredRows = new Set<number>(ctx.excludedRows);
    for (const child of validChildren) {
      for (let { row } = child.startPosition; row <= child.endPosition.row; row++) coveredRows.add(row);
    }

    const parts = planContainerRemainder({
      codeLines: ctx.codeLines,
      containerStartRow: containerNode.startPosition.row,
      leadingStartRow,
      containerEndRow: containerNode.endPosition.row,
      coveredRows,
      containerHeader: this.extractContainerHeader(containerNode, ctx.code),
      containerHeaderRow: this.containerHeaderRow(containerNode),
      hierarchyPrefix: this.buildHierarchyPrefix(hierarchyHeaders),
      maxChunkSize: this.config.maxChunkSize,
      minContentLength: 50,
    });

    const split = parts.length > 1;
    parts.forEach((part, i) => {
      chunks.push({
        content: part.content,
        startLine: part.startLine,
        endLine: part.endLine,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: ctx.containerChunkType ?? identity.chunkType,
          name:
            split && identity.name !== undefined ? `${identity.name} (part ${i + 1}/${parts.length})` : identity.name,
          symbolId: split && identity.symbolId !== undefined ? `${identity.symbolId}#part${i + 1}` : identity.symbolId,
          parentSymbolId: split ? (identity.symbolId ?? identity.parentSymbolId) : identity.parentSymbolId,
          parentType: identity.parentType,
          // A single contiguous run needs no ranges — startLine..endLine says it.
          ...(part.lineRanges.length > 1 ? { lineRanges: part.lineRanges } : {}),
        },
      });
    });
  }

  /**
   * Extract the "body" of a container node (class/module), excluding child chunks (methods).
   * Collects class-level code: includes, associations, scopes, validations, constants, etc.
   * Returns the collected lines as a string, or undefined if nothing remains.
   */
  /* v8 ignore next 23 -- only called from no-hooks fallback, unreachable for current language configs */
  private extractContainerBody(containerNode: AstNode, childNodes: AstNode[], code: string): string | undefined {
    const containerStartRow = containerNode.startPosition.row;
    const containerEndRow = containerNode.endPosition.row;
    const lines = code.split("\n");

    const methodLines = new Set<number>();
    for (const child of childNodes) {
      for (let { row } = child.startPosition; row <= child.endPosition.row; row++) {
        methodLines.add(row);
      }
    }

    const bodyLines: string[] = [];
    for (let row = containerStartRow; row <= containerEndRow; row++) {
      if (!methodLines.has(row)) {
        bodyLines.push(lines[row]);
      }
    }

    const body = bodyLines.join("\n").trim();
    return body.length > 0 ? body : undefined;
  }

  /**
   * Consult hook filterNode methods for a verdict on whether to include a node.
   * Returns true (include), false (exclude), or undefined (no opinion).
   */
  private consultFilterHooks(
    hooks: ChunkingHook[],
    node: AstNode,
    code: string,
    filePath: string,
  ): boolean | undefined {
    for (const hook of hooks) {
      if (hook.filterNode) {
        const result = hook.filterNode(node, code, filePath);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }

  /**
   * Extract function/class name from AST node
   */
  private extractName(
    node: AstNode,
    code: string,
    nameExtractor?: (node: AstNode, code: string) => string | undefined,
  ): string | undefined {
    // Try custom extractor first (e.g., for RSpec call nodes)
    if (nameExtractor) {
      const name = nameExtractor(node, code);
      if (name) return name;
    }

    // Try to find name node
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      return code.substring(nameNode.startIndex, nameNode.endIndex);
    }

    // For some node types, name might be in a different location
    for (const child of node.children) {
      if (child.type === "identifier" || child.type === "type_identifier") {
        return code.substring(child.startIndex, child.endIndex);
      }
    }

    return undefined;
  }

  /**
   * Map AST node type to chunk type
   */
  private getChunkType(nodeType: string): "function" | "class" | "interface" | "block" | "test" | "test_setup" {
    // bd tea-rags-mcp-c5wt — Java `constructor_declaration` is method-like
    // (instance-bound per .claude/rules/symbolid-convention.md, `Class#Class`).
    // Without this, constructor chunks default to "block" and downstream
    // filters scoping by chunkType === "function" miss them.
    if (nodeType.includes("function") || nodeType.includes("method") || nodeType.includes("constructor")) {
      return "function";
    }
    if (nodeType.includes("class") || nodeType.includes("struct") || nodeType.includes("module")) {
      return "class";
    }
    if (nodeType.includes("interface") || nodeType.includes("trait")) {
      return "interface";
    }
    return "block";
  }
}

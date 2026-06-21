/**
 * TreeSitterChunker - AST-aware code chunking using tree-sitter
 * Primary chunking strategy for supported languages
 *
 * OPTIMIZATION: Lazy-loads parsers on first use to reduce startup time.
 * Before: All 9 parsers loaded at construction (~3-5 seconds)
 * After: Parsers loaded on demand (~0ms startup, ~100-200ms first use per language)
 */

import Parser from "tree-sitter";

import type { ChunkDecision, MacroSymbol } from "../../../../contracts/types/chunker.js";
import type {
  LanguageChunkerHooks,
  LanguageFactoryDescriptor,
  LanguageKernel,
  SymbolIdComposer,
} from "../../../../contracts/types/language.js";
import { isStaticMethodNode } from "../../../../infra/symbolid/index.js";
import type { ChunkerConfig, CodeChunk } from "../../../../types.js";
import { isDebug } from "../infra/runtime.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character.js";
import type { LanguageConfig } from "./config.js";
import { createHookContext, type ChunkingHook, type HookContext } from "./hooks/types.js";
import { MarkdownChunker } from "./markdown-chunker.js";

export class TreeSitterChunker implements CodeChunker {
  /** Cache of initialized parsers (lazy-loaded) */
  private readonly parserCache: Map<string, LanguageConfig> = new Map();
  private readonly fallbackChunker: CharacterChunker;
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
   * Top-level symbols have no separator: "name"
   */
  private buildSymbolId(name?: string, parentName?: string, isStatic?: boolean): string | undefined {
    if (!name) return undefined;
    if (!parentName) return name;
    return this.symbolIds.compose(parentName, name, { methodKind: isStatic ? "static" : "instance" });
  }

  /**
   * Emit synthetic method-symbol chunks for Ruby class-body DSL macros
   * (attr_accessor / attr_reader / attr_writer / cattr_* / mattr_* /
   * delegate / define_method) found anywhere inside `containerNode`. Each
   * macro can declare multiple methods at the enclosing class scope;
   * without these chunks, a language's bare-id call resolution can't
   * land on `Class#accessor` / `Class#delegated_method` and
   * `get_callers` / `get_callees` come up empty on macro-heavy code
   * (e.g. Rails — bd tea-rags-mcp-3nf3 + tea-rags-mcp-zy3f).
   *
   * No-op unless the language provider supplies a macro-symbol extractor.
   *
   * Recurses into every nested scope container (driven by
   * `scopeContainerTypes` from the kernel; defaults to `class` / `module`)
   * so that nested-namespace cases (`class A; class B; attr_accessor :x;
   * end; end` → `A::B#x`) compose the full scope qualifier. Mirrors the
   * bdvm fix for regular `def`-emitted symbols.
   *
   * The chunk content is the literal source line of the macro call
   * (sufficient context for search hits to surface the declaration).
   * `chunkType` is `"function"` so it lines up with regular method
   * symbols in downstream filters / overlay masks.
   */
  private emitMacroSymbols(
    containerNode: Parser.SyntaxNode,
    parentSymbolId: string | undefined,
    parentType: string,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
    macroSymbols: ((containerNode: Parser.SyntaxNode) => MacroSymbol[]) | undefined,
    scopeContainerTypes: string[] | undefined,
    scopeSeparator: string | undefined,
  ): void {
    // No-op unless the language provider supplies a macro-symbol extractor.
    // Reached via the provider capability, not a direct import — keeps the
    // engine free of any `domains/language/<lang>` dependency.
    if (!macroSymbols) return;
    const lines = code.split("\n");
    this.walkMacroScopes(
      containerNode,
      parentSymbolId,
      parentType,
      code,
      filePath,
      language,
      chunks,
      lines,
      macroSymbols,
      scopeContainerTypes,
      scopeSeparator,
    );
  }

  /**
   * Walk a container tree depth-first, emitting macro symbols at each scope
   * with the correctly-composed `parentSymbolId`. When the walk crosses into
   * a nested scope container (a node type listed in `scopeContainerTypes`),
   * the parent qualifier is extended with that container's name using
   * `scopeSeparator` (the language's namespace join). The container's own
   * `parentType` is its tree-sitter node type — same shape the regular
   * def-emitted chunks carry.
   */
  private walkMacroScopes(
    containerNode: Parser.SyntaxNode,
    currentParent: string | undefined,
    parentType: string,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
    lines: string[],
    macroSymbols: (containerNode: Parser.SyntaxNode) => MacroSymbol[],
    scopeContainerTypes: string[] | undefined,
    scopeSeparator: string | undefined,
  ): void {
    // Emit macros declared directly in this container's body.
    const macros = macroSymbols(containerNode);
    for (const macro of macros) {
      const content = (lines[macro.startLine - 1] ?? "").trim() || `# ${macro.name}`;
      this.pushMacroSymbolChunk(macro, content, currentParent, parentType, filePath, language, chunks);
    }

    // Recurse into nested scope-container bodies. We descend the immediate
    // body statements only — same one-step-deep convention as the macro
    // extractor. Macros nested in `if` blocks or ActiveSupport::Concern
    // `included do … end` are intentionally out of scope (matches the
    // codegraph provider's top-level walk).
    const body = containerNode.childForFieldName("body");
    const stmts = body ? body.children : containerNode.children;
    const containers = scopeContainerTypes ?? ["class", "module"];
    for (const stmt of stmts) {
      if (!containers.includes(stmt.type)) continue;
      // A scope container without a name node is an unnamed scope
      // (Ruby `class << self` singleton_class). It contributes no segment
      // to the qualifier — macros declared inside compose at the enclosing
      // class scope, mirroring how the regular def-path treats singleton
      // methods (parent stays the class, `#` separator).
      const localName = this.extractName(stmt, code);
      const nestedParent = localName
        ? this.symbolIds.compose(currentParent ?? "", localName, {
            scopeSeparator: scopeSeparator ?? "::",
          })
        : currentParent;
      this.walkMacroScopes(
        stmt,
        nestedParent,
        // An unnamed scope keeps the enclosing container's parentType so
        // emitted symbols inherit the class/module shape, not the raw
        // singleton_class node type.
        localName ? stmt.type : parentType,
        code,
        filePath,
        language,
        chunks,
        lines,
        macroSymbols,
        scopeContainerTypes,
        scopeSeparator,
      );
    }
  }

  private pushMacroSymbolChunk(
    macro: MacroSymbol,
    content: string,
    parentSymbolId: string | undefined,
    parentType: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): void {
    const isStatic = macro.kind === "static";
    chunks.push({
      content,
      startLine: macro.startLine,
      endLine: macro.endLine,
      metadata: {
        filePath,
        language,
        chunkIndex: chunks.length,
        chunkType: "function",
        name: macro.name,
        parentSymbolId,
        parentType,
        symbolId: this.buildSymbolId(macro.name, parentSymbolId, isStatic),
        methodLines: macro.endLine - macro.startLine + 1,
      },
    });
  }

  /**
   * Check if a tree-sitter node has a specific modifier (e.g., "static").
   */
  private hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
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
  private computeEndLine(node: Parser.SyntaxNode): number {
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
  private unwrapDecoratedDefinition(node: Parser.SyntaxNode): Parser.SyntaxNode {
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
        macroSymbols: hooks.macroSymbols,
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
  ): Promise<{ chunks: CodeChunk[]; tree: Parser.Tree | null }> {
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

    try {
      const tree = langConfig.parser.parse(code);
      const chunks: CodeChunk[] = [];
      const nodes = this.findChunkableNodes(tree.rootNode, langConfig.chunkableTypes, langConfig.hooks, code, filePath);

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

        this.chunkSingleNode(node, index, code, filePath, language, chunks, decision);
      }

      if (chunks.length === 0 && code.length > 100) {
        // Chunk output falls back to character chunking, but the parse
        // succeeded — keep the tree so the codegraph walker still sees symbols.
        return { chunks: this.enforceMaxChunkSize(await this.fallbackChunker.chunk(code, filePath, language)), tree };
      }
      return { chunks: this.enforceMaxChunkSize(this.mergeSmallChunks(chunks)), tree };
    } catch (error) {
      console.error(`Tree-sitter parsing failed for ${filePath}:`, error);
      return {
        chunks: this.enforceMaxChunkSize(await this.fallbackChunker.chunk(code, filePath, language)),
        tree: null,
      };
    }
  }

  /**
   * Fallback for oversized nodes without valid children — character-based chunking.
   */
  private async chunkOversizedNode(
    node: Parser.SyntaxNode,
    parentName: string | undefined,
    parentType: string,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): Promise<void> {
    const content = code.substring(node.startIndex, node.endIndex);
    const nodeMethodLines = node.endPosition.row - node.startPosition.row + 1;
    const subChunks = await this.fallbackChunker.chunk(content, filePath, language);
    for (const subChunk of subChunks) {
      chunks.push({
        ...subChunk,
        startLine: node.startPosition.row + 1 + subChunk.startLine - 1,
        endLine: node.startPosition.row + 1 + subChunk.endLine - 1,
        metadata: {
          ...subChunk.metadata,
          chunkIndex: chunks.length,
          // Inherit symbolId + chunkType from the oversized parent method so
          // every split subChunk shares one symbolId. Without this fix the
          // character-fallback chunker yields chunkType="block" and
          // symbolId=undefined, breaking the "all chunks of one method
          // share the same symbolId" invariant that the codegraph slice
          // (and the existing MCP navigation layer) relies on.
          symbolId: this.buildSymbolId(parentName),
          chunkType: "function",
          parentSymbolId: parentName,
          parentType,
          methodLines: nodeMethodLines,
        },
      });
    }
  }

  /**
   * Handle nodes where children should be extracted (classes, modules, large containers).
   * Returns true if the node was handled, false if it should fall through to single-node chunking.
   */
  private async chunkWithChildExtraction(
    node: Parser.SyntaxNode,
    langConfig: LanguageConfig,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): Promise<boolean> {
    const parentName = this.extractName(node, code, langConfig.nameExtractor);
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
      const ctx = createHookContext(node, validChildren, code, { maxChunkSize: this.config.maxChunkSize }, filePath);
      for (const hook of langConfig.hooks ?? []) {
        // Hook chain stops as soon as a writer claims this container by
        // populating ctx.bodyChunks. See .claude/rules/chunker-hooks.md.
        if (ctx.bodyChunks.length > 0) break;
        hook.process(ctx);
      }

      const containerHeader = this.extractContainerHeader(node, code);
      await this.processChildren(
        validChildren,
        ctx,
        langConfig,
        code,
        filePath,
        language,
        parentName,
        parentType,
        chunks,
        [containerHeader],
      );

      // Synthetic method symbols from DSL macros (e.g. Ruby attr_accessor /
      // delegate / cattr_* / mattr_* / define_method). No-op unless the
      // provider supplies a macro extractor. Scope walk is driven by the
      // kernel's scopeContainerTypes + scopeSeparator.
      this.emitMacroSymbols(
        node,
        parentName,
        parentType,
        code,
        filePath,
        language,
        chunks,
        langConfig.macroSymbols,
        langConfig.scopeContainerTypes,
        langConfig.scopeSeparator,
      );

      if (langConfig.alwaysExtractChildren) {
        const hasHookChain = langConfig.hooks && langConfig.hooks.length > 0;
        if (hasHookChain) {
          for (const result of ctx.bodyChunks) {
            const bodyContent = `${containerHeader}\n${result.content}`;
            chunks.push({
              content: bodyContent,
              startLine: result.startLine,
              endLine: result.endLine,
              metadata: {
                filePath,
                language,
                chunkIndex: chunks.length,
                chunkType: (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
                name: result.name ?? parentName,
                parentSymbolId: result.parentSymbolId ?? parentName,
                parentType,
                symbolId: result.symbolId ?? this.buildSymbolId(parentName),
                lineRanges: result.lineRanges,
              },
            });
          }
        } else {
          // bd tea-rags-mcp-b7k3 — when methods are extracted as separate
          // chunks but the language has no hook chain (Python), emit ONE
          // narrow parent class chunk covering only the signature + leading
          // class-level attributes BEFORE the first method declaration.
          // Without this narrowing the parent chunk spans the FULL class
          // range, exceeds maxChunkSize on real classes (e.g. Flask), and
          // gets split by enforceMaxChunkSize into anonymous Foo#part1..N
          // that duplicate method bodies and shadow the first method in
          // find_symbol lookups.
          this.emitNarrowParentClassChunk(
            node,
            validChildren,
            parentName,
            parentType,
            code,
            filePath,
            language,
            chunks,
          );
        }
      }
      return true;
    }

    // No valid children found
    const content = code.substring(node.startIndex, node.endIndex);
    const isTooLarge = content.length > this.config.maxChunkSize;
    if (isTooLarge) {
      await this.chunkOversizedNode(node, parentName, parentType, code, filePath, language, chunks);
      return true;
    }

    // alwaysExtractChildren but no valid children — fall through to single
    // chunk. But still emit DSL macro symbols at this scope, so a small
    // class like `class A; attr_reader :foo; end` produces `A#foo` even when
    // its body has no `def` large enough to trigger child extraction
    // (bd tea-rags-mcp-3nf3 + tea-rags-mcp-zy3f). The caller will emit the
    // single-class chunk via chunkSingleNode after this returns false; we
    // emit the per-accessor function chunks here so they ship alongside it.
    this.emitMacroSymbols(
      node,
      parentName,
      parentType,
      code,
      filePath,
      language,
      chunks,
      langConfig.macroSymbols,
      langConfig.scopeContainerTypes,
      langConfig.scopeSeparator,
    );
    return false;
  }

  /**
   * Handle regular single-node chunking (no child extraction).
   */
  private chunkSingleNode(
    node: Parser.SyntaxNode,
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
    if (decision.kind === "emit") {
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
    const nodeName = this.extractName(node, code);
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
        symbolId: this.buildSymbolId(nodeName),
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
    const result: CodeChunk[] = [];
    for (const chunk of chunks) {
      if (chunk.content.length <= max) {
        result.push(chunk);
        continue;
      }
      const parts = this.splitOversizedChunk(chunk, max);
      result.push(...parts);
    }
    for (let i = 0; i < result.length; i++) {
      result[i].metadata.chunkIndex = i;
    }
    return result;
  }

  private splitOversizedChunk(chunk: CodeChunk, max: number): CodeChunk[] {
    const segments = this.splitContentIntoSegments(chunk.content, max);
    const totalLines = Math.max(1, chunk.endLine - chunk.startLine + 1);
    const originalSymbolId = chunk.metadata.symbolId;
    const originalName = chunk.metadata.name ?? "chunk";
    const parentSymbolId = originalSymbolId ?? chunk.metadata.parentSymbolId;

    const parts: CodeChunk[] = [];
    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segLines = Math.max(1, seg.split("\n").length);
      const startLine = chunk.startLine + Math.round((cursor / chunk.content.length) * totalLines);
      cursor += seg.length;
      const endLine =
        chunk.startLine + Math.min(totalLines - 1, Math.round((cursor / chunk.content.length) * totalLines));
      const partSymbolId = originalSymbolId ? `${originalSymbolId}#part${i + 1}` : undefined;
      parts.push({
        content: seg,
        startLine,
        endLine: Math.max(endLine, startLine + 1),
        metadata: {
          ...chunk.metadata,
          chunkIndex: chunk.metadata.chunkIndex,
          name: `${originalName} (part ${i + 1}/${segments.length})`,
          symbolId: partSymbolId,
          parentSymbolId,
          methodLines: chunk.metadata.methodLines ?? segLines,
        },
      });
    }
    return parts;
  }

  /**
   * Split text into segments each <= max chars, preferring line boundaries.
   * If a single line is wider than max, it gets character-sliced.
   */
  private splitContentIntoSegments(content: string, max: number): string[] {
    const lines = content.split("\n");
    const segments: string[] = [];
    let current = "";
    for (const line of lines) {
      if (line.length > max) {
        if (current.length > 0) {
          segments.push(current);
          current = "";
        }
        for (let i = 0; i < line.length; i += max) {
          segments.push(line.slice(i, i + max));
        }
        continue;
      }
      const candidate = current.length === 0 ? line : `${current}\n${line}`;
      if (candidate.length > max) {
        segments.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) {
      segments.push(current);
    }
    return segments.length > 0 ? segments : [content.slice(0, max)];
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
  private extractContainerHeader(node: Parser.SyntaxNode, code: string): string {
    const lines = code.substring(node.startIndex, node.endIndex).split("\n");
    return lines[0].trim();
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
   * Build full parent name path from hierarchy names.
   *
   * bd tea-rags-mcp-ksb8 — Previously joined with ` > ` (spaces),
   * producing invalid `Scaffold > route#decorator` symbolIds. The
   * canonical separator is the language's `scopeSeparator` (`.` for
   * Python/TS/JS, `::` for Ruby/Rust). See
   * `.claude/rules/symbolid-convention.md`.
   */
  private buildParentPath(hierarchyNames: string[], scopeSeparator?: string): string | undefined {
    if (hierarchyNames.length === 0) return undefined;
    // Namespace fold through the composer (scopeSeparator), mirroring
    // composeParentSymbol — keeps the separator rule in one place.
    return hierarchyNames.reduce((acc, name) => this.symbolIds.compose(acc, name, { scopeSeparator }), "");
  }

  /**
   * Process child nodes of a container, recursing into nested containers.
   * Handles the child extraction loop with support for arbitrary nesting depth.
   */
  private async processChildren(
    validChildren: Parser.SyntaxNode[],
    ctx: HookContext,
    langConfig: LanguageConfig,
    code: string,
    filePath: string,
    language: string,
    parentName: string | undefined,
    parentType: string,
    chunks: CodeChunk[],
    hierarchyHeaders: string[] = [],
  ): Promise<void> {
    // If hook chain has taken over chunking (e.g., RSpec scope chunker),
    // skip child emission — all chunks are in ctx.bodyChunks
    if (ctx.skipChildren) return;

    // bd tea-rags-mcp-a466 — overload disambiguation. Multiple
    // `method_declaration` nodes with the same name produce identical
    // composed symbolIds (e.g. three `upperCase(...)` overloads under
    // `class StringUtils` all compose as `StringUtils.upperCase`). When
    // the language opts in via `disambiguateOverloads: true`, track
    // occurrences per composed symbolId WITHIN this processChildren
    // pass and suffix every occurrence after the first with `~N`
    // (1-based, first stays unchanged). The same convention runs on
    // the codegraph provider's `collectSymbols` so cg_symbols + Qdrant
    // payload agree on the same physical AST node. Per
    // `.claude/rules/symbolid-convention.md`. Default-off so TS get/set
    // pairs and Python `@functools.singledispatch` stub/impl pairs keep
    // their first-occurrence behaviour.
    const symbolIdOccurrences = new Map<string, number>();
    const disambiguateOverloads = langConfig.disambiguateOverloads === true;
    const disambiguateSymbolId = (baseId: string | undefined): string | undefined => {
      if (baseId === undefined) return undefined;
      if (!disambiguateOverloads) return baseId;
      const seen = symbolIdOccurrences.get(baseId) ?? 0;
      const next = seen + 1;
      symbolIdOccurrences.set(baseId, next);
      return next === 1 ? baseId : `${baseId}~${next}`;
    };

    for (let ci = 0; ci < validChildren.length; ci++) {
      const childNode = validChildren[ci];
      const childContent = code.substring(childNode.startIndex, childNode.endIndex);

      // If child is too large, use character fallback. Mirror the
      // `chunkOversizedNode` invariant at the method scope: every
      // sub-chunk shares the composed method symbolId (`Foo#__init__`)
      // and `chunkType: "function"`. Before bd tea-rags-mcp-5xie, the
      // raw fallback chunks carried `symbolId: undefined` /
      // `chunkType: "block"`, so `find_symbol("Flask#__init__")` came up
      // empty even though cg_symbols had the entry. See
      // .claude/rules/symbolid-convention.md and the regression test in
      // tree-sitter.oversized-symbolid.test.ts.
      if (childContent.length > this.config.maxChunkSize) {
        const childMethodLines = childNode.endPosition.row - childNode.startPosition.row + 1;
        const semanticNode = this.unwrapDecoratedDefinition(childNode);
        const childName = this.extractName(semanticNode, code, langConfig.nameExtractor);
        const isStatic = isStaticMethodNode(semanticNode);
        const intermediateScopes = this.collectIntermediateScopes(childNode, langConfig, code);
        const effectiveParent = this.composeParentSymbol(parentName, intermediateScopes, langConfig.scopeSeparator);
        // bd tea-rags-mcp-a466 — disambiguate overloads BEFORE deciding
        // the chunk's symbolId so oversized-method splits inherit the
        // already-suffixed id (each split shares the composed method id;
        // see bd tea-rags-mcp-5xie invariant). Without this, two oversized
        // overloads would collapse into the same symbolId across parts.
        const methodSymbolId = disambiguateSymbolId(this.buildSymbolId(childName, effectiveParent, isStatic));
        const methodChunkType = this.getChunkType(semanticNode.type);
        const subChunks = await this.fallbackChunker.chunk(childContent, filePath, language);
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            startLine: childNode.startPosition.row + 1 + subChunk.startLine - 1,
            endLine: childNode.endPosition.row + 1 + subChunk.endLine - 1,
            metadata: {
              ...subChunk.metadata,
              chunkIndex: chunks.length,
              chunkType: methodChunkType,
              name: childName,
              // Every split shares the composed METHOD symbolId
              // (bd tea-rags-mcp-5xie invariant).
              symbolId: methodSymbolId,
              // bd tea-rags-mcp-cpbv — parts point at the CLASS as their
              // parent, not at the method itself. The 5xie self-reference
              // (parentSymbolId === symbolId) created a self-loop that
              // broke MCP navigation between parts and shadowed the
              // class lineage.
              parentSymbolId: effectiveParent ?? parentName,
              parentType,
              methodLines: childMethodLines,
            },
          });
        }
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

      // bd tea-rags-mcp-07fr — Recurse-as-container is correct only when
      // the child is itself a SCOPE container (class / module). If a
      // class method (`def route`) contains an inner function
      // (`def decorator`), recursing here would emit ONLY the inner
      // function and shadow the outer method. The outer method must be
      // emitted as a leaf chunk so `find_symbol("Scaffold#route")`
      // resolves. The grandchildren (inner defs) are intentionally NOT
      // chunked separately — decorator-factories and helper closures
      // rarely need standalone search hits.
      const isScopeContainerChild = langConfig.scopeContainerTypes?.includes(childNode.type) ?? false;
      const childIsRubyHookContainer = (langConfig.hooks?.length ?? 0) > 0;
      const canRecurseAsContainer = isScopeContainerChild || childIsRubyHookContainer;

      if (validGrandChildren.length > 0 && langConfig.alwaysExtractChildren && canRecurseAsContainer) {
        // Recurse: treat this child as a container
        const childName = this.extractName(childNode, code, langConfig.nameExtractor);
        const childHeader = this.extractContainerHeader(childNode, code);
        const childCtx = createHookContext(
          childNode,
          validGrandChildren,
          code,
          {
            maxChunkSize: this.config.maxChunkSize,
          },
          filePath,
        );
        for (const hook of langConfig.hooks ?? []) {
          if (childCtx.bodyChunks.length > 0) break;
          hook.process(childCtx);
        }

        const fullParentName = this.buildParentPath(
          [...(parentName ? [parentName] : []), ...(childName ? [childName] : [])],
          langConfig.scopeSeparator,
        );

        await this.processChildren(
          validGrandChildren,
          childCtx,
          langConfig,
          code,
          filePath,
          language,
          fullParentName,
          childNode.type,
          chunks,
          [...hierarchyHeaders, childHeader],
        );

        // Body chunks from hook chain for this nested container
        const hierarchyPrefix = this.buildHierarchyPrefix(hierarchyHeaders);
        for (const result of childCtx.bodyChunks) {
          const bodyContent =
            hierarchyHeaders.length > 0 ? `${hierarchyPrefix}${childHeader}\n${result.content}` : result.content;
          chunks.push({
            content: bodyContent,
            startLine: result.startLine,
            endLine: result.endLine,
            metadata: {
              filePath,
              language,
              chunkIndex: chunks.length,
              chunkType: (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
              name: result.name ?? childName,
              parentSymbolId: result.parentSymbolId ?? fullParentName ?? parentName,
              parentType,
              symbolId: result.symbolId ?? this.buildSymbolId(childName),
              lineRanges: result.lineRanges,
            },
          });
        }

        // Note: DSL macros for nested scope containers are emitted by the
        // outer `chunkWithChildExtraction` call via `walkMacroScopes`, which
        // descends into every nested scope container from the top-level
        // container. We do NOT call `emitMacroSymbols` here — that would
        // duplicate the synthetic method chunks.
        continue;
      }

      // Leaf child — emit as chunk with hierarchy context
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

      // Python `decorated_definition` wraps a `function_definition` whose
      // decorators (@classmethod / @staticmethod) drive the instance vs
      // class-method classification. The outer wrapper has no `name` field
      // and `classifyMethod` only branches on the inner type, so name
      // extraction and static detection must read the inner node — but
      // chunk content/range stays on the outer wrapper so the decorator
      // remains visible. See `.claude/rules/symbolid-convention.md`.
      const semanticNode = this.unwrapDecoratedDefinition(childNode);
      const childName = this.extractName(semanticNode, code, langConfig.nameExtractor);
      // Universal `#` (instance) vs `.` (class/static) — single source
      // of truth in `infra/symbolid`. See
      // `.claude/rules/symbolid-convention.md`.
      const isStatic = isStaticMethodNode(semanticNode);
      // Accumulate intermediate scope-container ancestor names between
      // the outer container and the leaf (Ruby: nested `module`/`class`).
      // Without this, the leaf's parentSymbolId stays at the OUTERMOST
      // container's name and diverges from the codegraph form
      // (bd tea-rags-mcp-bdvm). When `scopeContainerTypes` is unset, the
      // returned list is empty and behaviour is unchanged.
      const intermediateScopes = this.collectIntermediateScopes(childNode, langConfig, code);
      const effectiveParent = this.composeParentSymbol(parentName, intermediateScopes, langConfig.scopeSeparator);
      // bd tea-rags-mcp-a466 — disambiguate per-overload (see comment at
      // the top of processChildren). The first occurrence under a given
      // (parent, name) keeps its symbolId; subsequent occurrences get
      // a `~N` suffix.
      const symbolId = disambiguateSymbolId(this.buildSymbolId(childName, effectiveParent, isStatic));
      chunks.push({
        content: finalContent,
        startLine,
        endLine: this.computeEndLine(childNode),
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: this.getChunkType(semanticNode.type),
          name: childName,
          parentSymbolId: effectiveParent,
          parentType,
          symbolId,
          methodLines: this.computeEndLine(childNode) - (childNode.startPosition.row + 1),
        },
      });
    }
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
  private collectIntermediateScopes(leafNode: Parser.SyntaxNode, langConfig: LanguageConfig, code: string): string[] {
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
    node: Parser.SyntaxNode,
    chunkableTypes: string[],
    hooks?: ChunkingHook[],
    code?: string,
    filePath?: string,
  ): Parser.SyntaxNode[] {
    const nodes: Parser.SyntaxNode[] = [];

    const traverse = (n: Parser.SyntaxNode) => {
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
    parentNode: Parser.SyntaxNode,
    childChunkTypes: string[],
    hooks?: ChunkingHook[],
    code?: string,
    filePath?: string,
  ): Parser.SyntaxNode[] {
    const nodes: Parser.SyntaxNode[] = [];

    const traverse = (n: Parser.SyntaxNode) => {
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
   * Emit ONE narrow parent class chunk covering the lines BEFORE the first
   * extracted child (method) — class signature, docstring, class-level
   * attributes. The parent chunk MUST NOT span the full class range when
   * methods have been extracted into their own chunks: the parent's content
   * would then duplicate method bodies AND get split by enforceMaxChunkSize
   * into anonymous Foo#part1..partN whose line ranges are bogus linear
   * interpolations across the full class span.
   *
   * Used by no-hook languages with `alwaysExtractChildren` (Python).
   * Languages with hooks (TS/Ruby) emit narrow chunks via `ctx.bodyChunks`
   * which the hook chain populates with proper ranges.
   *
   * bd tea-rags-mcp-b7k3.
   */
  private emitNarrowParentClassChunk(
    containerNode: Parser.SyntaxNode,
    validChildren: Parser.SyntaxNode[],
    parentName: string | undefined,
    parentType: string,
    code: string,
    filePath: string,
    language: string,
    chunks: CodeChunk[],
  ): void {
    // First child node is the first method (validChildren retains source order
    // because findChildChunkableNodes does a depth-first traversal). Use its
    // startPosition as the cutoff for the parent chunk.
    const firstChild = validChildren.reduce(
      (earliest, c) => (c.startPosition.row < earliest.startPosition.row ? c : earliest),
      validChildren[0],
    );
    const classStartRow = containerNode.startPosition.row;
    const cutoffRow = firstChild.startPosition.row;
    const lines = code.split("\n");
    // Slice [classStart, cutoff) — header row inclusive, first-method row
    // exclusive. Methods live at cutoffRow onward and are emitted separately.
    const headerLines = lines.slice(classStartRow, cutoffRow);
    const content = headerLines.join("\n").trimEnd();
    if (content.length < 50) return;
    chunks.push({
      content,
      startLine: classStartRow + 1,
      // endLine is the last header row (1-based, inclusive). cutoffRow is
      // 0-based for firstChild.startPosition; the row above it is the last
      // line of the header region.
      endLine: Math.max(classStartRow + 1, cutoffRow),
      metadata: {
        filePath,
        language,
        chunkIndex: chunks.length,
        chunkType: this.getChunkType(containerNode.type),
        name: parentName,
        parentSymbolId: parentName,
        parentType,
        symbolId: this.buildSymbolId(parentName),
      },
    });
  }

  /**
   * Extract the "body" of a container node (class/module), excluding child chunks (methods).
   * Collects class-level code: includes, associations, scopes, validations, constants, etc.
   * Returns the collected lines as a string, or undefined if nothing remains.
   */
  /* v8 ignore next 23 -- only called from no-hooks fallback, unreachable for current language configs */
  private extractContainerBody(
    containerNode: Parser.SyntaxNode,
    childNodes: Parser.SyntaxNode[],
    code: string,
  ): string | undefined {
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
    code: string,
    nameExtractor?: (node: Parser.SyntaxNode, code: string) => string | undefined,
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

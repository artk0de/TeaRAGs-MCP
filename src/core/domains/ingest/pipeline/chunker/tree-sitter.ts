/**
 * TreeSitterChunker - AST-aware code chunking using tree-sitter
 * Primary chunking strategy for supported languages
 *
 * OPTIMIZATION: Lazy-loads parsers on first use to reduce startup time.
 * Before: All 9 parsers loaded at construction (~3-5 seconds)
 * After: Parsers loaded on demand (~0ms startup, ~100-200ms first use per language)
 */

import Parser from "tree-sitter";

import type { ChunkerConfig, CodeChunk } from "../../../../types.js";
import { isDebug } from "../infra/runtime.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character.js";
import { LANGUAGE_DEFINITIONS, type LanguageConfig, type LanguageDefinition } from "./config.js";
import { MarkdownChunker } from "./hooks/markdown/index.js";
import { createHookContext, type ChunkingHook, type HookContext } from "./hooks/types.js";

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
   * Build symbolId from name and optional parentName
   * Format: "ParentName.childName" or just "name"
   */
  private buildSymbolId(name?: string, parentName?: string): string | undefined {
    if (!name) return undefined;
    return parentName ? `${parentName}.${name}` : name;
  }

  /**
   * Compute 1-based endLine from a tree-sitter node.
   * tree-sitter endPosition.row is inclusive (same row for single-line nodes),
   * so we ensure endLine > startLine for at least 1 line span.
   */
  private computeEndLine(node: Parser.SyntaxNode): number {
    return Math.max(node.startPosition.row + 2, node.endPosition.row + 1);
  }

  constructor(private readonly config: ChunkerConfig) {
    this.fallbackChunker = new CharacterChunker(config);
    this.markdownChunker = new MarkdownChunker({ maxChunkSize: this.config.maxChunkSize }, this.fallbackChunker);
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

    // Check if language is defined
    const definition = LANGUAGE_DEFINITIONS[language];
    if (!definition) {
      return null;
    }

    // Start loading
    const loadPromise = this.initializeParser(language, definition);
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
   * Initialize a parser for a specific language
   */
  private async initializeParser(language: string, definition: LanguageDefinition): Promise<LanguageConfig | null> {
    try {
      const startTime = Date.now();

      // Dynamic import of language module
      const mod = (await definition.loadModule()) as Record<string, unknown>;
      const langModule = (
        definition.extractLanguage ? definition.extractLanguage(mod) : mod.default || mod
      ) as Parser.Language;

      // Create and configure parser
      const parser = new Parser();
      parser.setLanguage(langModule);

      if (isDebug()) {
        console.error(`[TreeSitter] Lazy-loaded ${language} parser in ${Date.now() - startTime}ms`);
      }

      return {
        parser,
        chunkableTypes: definition.chunkableTypes,
        childChunkTypes: definition.childChunkTypes,
        alwaysExtractChildren: definition.alwaysExtractChildren,
        isDocumentation: definition.isDocumentation,
        hooks: definition.hooks,
        nameExtractor: definition.nameExtractor,
      };
    } catch (error) {
      console.error(`[TreeSitter] Failed to load parser for ${language}:`, error);
      return null;
    }
  }

  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
    // Check if this language should skip tree-sitter (e.g., markdown uses remark)
    const definition = LANGUAGE_DEFINITIONS[language];
    if (definition && (definition as LanguageDefinition & { skipTreeSitter?: boolean }).skipTreeSitter) {
      // Use specialized chunker for this language (e.g., remark for markdown)
      if (definition.isDocumentation) {
        return this.markdownChunker.chunk(code, filePath, language);
      }
    }

    // Lazy-load parser for this language
    const langConfig = await this.getLanguageConfig(language);

    if (!langConfig) {
      // Fallback to character-based chunking
      return this.fallbackChunker.chunk(code, filePath, language);
    }

    try {
      const tree = langConfig.parser.parse(code);

      const chunks: CodeChunk[] = [];

      // Find all chunkable nodes
      const nodes = this.findChunkableNodes(tree.rootNode, langConfig.chunkableTypes, langConfig.hooks, code, filePath);

      for (const [index, node] of nodes.entries()) {
        const content = code.substring(node.startIndex, node.endIndex);

        // Skip chunks that are too small
        if (content.length < 50) {
          continue;
        }

        // Determine if we should extract children from this node.
        // Two cases: (1) node is too large for a single chunk, or
        // (2) language always extracts children (e.g., Ruby methods from classes)
        const isTooLarge = content.length > this.config.maxChunkSize * 2;
        const hasChildTypes = langConfig.childChunkTypes && langConfig.childChunkTypes.length > 0;
        const shouldExtractChildren = hasChildTypes && (isTooLarge || langConfig.alwaysExtractChildren);

        if (shouldExtractChildren) {
          const parentName = this.extractName(node, code, langConfig.nameExtractor);
          const parentType = node.type;

          const childNodes = this.findChildChunkableNodes(
            node,
            langConfig.childChunkTypes ?? [],
            langConfig.hooks,
            code,
            filePath,
          );

          // Filter to children that meet minimum size
          const validChildren = childNodes.filter((c) => code.substring(c.startIndex, c.endIndex).length >= 50);

          if (validChildren.length > 0) {
            // Run hook chain
            const ctx = createHookContext(
              node,
              validChildren,
              code,
              {
                maxChunkSize: this.config.maxChunkSize,
              },
              filePath,
            );
            for (const hook of langConfig.hooks ?? []) {
              hook.process(ctx);
            }

            // Extract each child as individual chunk, recursing into nested containers
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

            // Extract class-level code (everything outside methods) as body chunk(s)
            if (langConfig.alwaysExtractChildren) {
              const hasHookChain = langConfig.hooks && langConfig.hooks.length > 0;
              if (hasHookChain) {
                // Hook chain ran — use hook-provided body chunks (may be empty)
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
                      parentName: result.parentName ?? parentName,
                      parentType,
                      symbolId: result.symbolId ?? this.buildSymbolId(parentName),
                      lineRanges: result.lineRanges,
                    },
                  });
                }
              } /* v8 ignore next 19 -- defensive: all languages with alwaysExtractChildren have hooks */ else {
                // No hooks — generic fallback: single body chunk
                const bodyContent = this.extractContainerBody(node, validChildren, code);
                if (bodyContent && bodyContent.trim().length >= 50) {
                  chunks.push({
                    content: bodyContent.trim(),
                    startLine: node.startPosition.row + 1,
                    endLine: this.computeEndLine(node),
                    metadata: {
                      filePath,
                      language,
                      chunkIndex: chunks.length,
                      chunkType: "block",
                      name: parentName,
                      parentName,
                      parentType,
                      symbolId: this.buildSymbolId(parentName),
                    },
                  });
                }
              }
            }
            continue;
          }

          // No valid children found
          if (isTooLarge) {
            // Fall back to character chunking for oversized nodes
            const nodeMethodLines = node.endPosition.row - node.startPosition.row + 1;
            const subChunks = await this.fallbackChunker.chunk(content, filePath, language);
            for (const subChunk of subChunks) {
              chunks.push({
                ...subChunk,
                // Offset arithmetic — not a direct endLine assignment, so computeEndLine not needed.
                // The fallback chunker produces its own relative line offsets within the sub-content.
                startLine: node.startPosition.row + 1 + subChunk.startLine - 1,
                endLine: node.startPosition.row + 1 + subChunk.endLine - 1,
                metadata: {
                  ...subChunk.metadata,
                  chunkIndex: chunks.length,
                  parentName,
                  parentType,
                  methodLines: nodeMethodLines,
                },
              });
            }
            continue;
          }
          // alwaysExtractChildren but no valid children — fall through to single chunk
        }

        const nodeName = this.extractName(node, code, langConfig.nameExtractor);
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

      // If no chunks found or file is small, use fallback
      if (chunks.length === 0 && code.length > 100) {
        return this.fallbackChunker.chunk(code, filePath, language);
      }

      return this.mergeSmallChunks(chunks);
    } catch (error) {
      // On parsing error, fallback to character-based chunking
      console.error(`Tree-sitter parsing failed for ${filePath}:`, error);
      return this.fallbackChunker.chunk(code, filePath, language);
    }
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
      return (
        lines <= TreeSitterChunker.MERGE_THRESHOLD &&
        !chunk.metadata.parentName &&
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

  supportsLanguage(language: string): boolean {
    return language in LANGUAGE_DEFINITIONS;
  }

  getStrategyName(): string {
    return "tree-sitter";
  }

  /**
   * Get list of supported languages
   */
  getSupportedLanguages(): string[] {
    return Object.keys(LANGUAGE_DEFINITIONS);
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
      available: Object.keys(LANGUAGE_DEFINITIONS),
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
   */
  private buildParentPath(hierarchyNames: string[]): string | undefined {
    if (hierarchyNames.length === 0) return undefined;
    return hierarchyNames.join(" > ");
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

    for (let ci = 0; ci < validChildren.length; ci++) {
      const childNode = validChildren[ci];
      const childContent = code.substring(childNode.startIndex, childNode.endIndex);

      // If child is too large, use character fallback
      if (childContent.length > this.config.maxChunkSize * 2) {
        const childMethodLines = childNode.endPosition.row - childNode.startPosition.row + 1;
        const subChunks = await this.fallbackChunker.chunk(childContent, filePath, language);
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            startLine: childNode.startPosition.row + 1 + subChunk.startLine - 1,
            endLine: childNode.endPosition.row + 1 + subChunk.endLine - 1,
            metadata: {
              ...subChunk.metadata,
              chunkIndex: chunks.length,
              parentName,
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

      if (validGrandChildren.length > 0 && langConfig.alwaysExtractChildren) {
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
          hook.process(childCtx);
        }

        const fullParentName = this.buildParentPath([
          ...(parentName ? [parentName] : []),
          ...(childName ? [childName] : []),
        ]);

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
              parentName: result.parentName ?? fullParentName ?? parentName,
              parentType,
              symbolId: result.symbolId ?? this.buildSymbolId(childName),
              lineRanges: result.lineRanges,
            },
          });
        }
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

      const childName = this.extractName(childNode, code, langConfig.nameExtractor);
      chunks.push({
        content: finalContent,
        startLine,
        endLine: this.computeEndLine(childNode),
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: this.getChunkType(childNode.type),
          name: childName,
          parentName,
          parentType,
          symbolId: this.buildSymbolId(childName, parentName),
          methodLines: this.computeEndLine(childNode) - (childNode.startPosition.row + 1),
        },
      });
    }
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
    if (nodeType.includes("function") || nodeType.includes("method")) {
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

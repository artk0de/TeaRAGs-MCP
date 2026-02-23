/**
 * TreeSitterChunker - AST-aware code chunking using tree-sitter
 * Primary chunking strategy for supported languages
 *
 * OPTIMIZATION: Lazy-loads parsers on first use to reduce startup time.
 * Before: All 9 parsers loaded at construction (~3-5 seconds)
 * After: Parsers loaded on demand (~0ms startup, ~100-200ms first use per language)
 */

import type { Content } from "mdast";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import Parser from "tree-sitter";

import type { ChunkerConfig, CodeChunk } from "../types.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character-chunker.js";
import { LANGUAGE_DEFINITIONS, type LanguageConfig, type LanguageDefinition } from "./chunker-config.js";
import { createHookContext } from "./hooks/types.js";

export class TreeSitterChunker implements CodeChunker {
  /** Cache of initialized parsers (lazy-loaded) */
  private readonly parserCache: Map<string, LanguageConfig> = new Map();
  private readonly fallbackChunker: CharacterChunker;
  /** Track loading promises to avoid duplicate loads */
  private readonly loadingPromises: Map<string, Promise<LanguageConfig | null>> = new Map();

  /**
   * Build symbolId from name and optional parentName
   * Format: "ParentName.childName" or just "name"
   */
  private buildSymbolId(name?: string, parentName?: string): string | undefined {
    if (!name) return undefined;
    return parentName ? `${parentName}.${name}` : name;
  }

  constructor(private readonly config: ChunkerConfig) {
    this.fallbackChunker = new CharacterChunker(config);
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

      if (process.env.DEBUG) {
        console.error(`[TreeSitter] Lazy-loaded ${language} parser in ${Date.now() - startTime}ms`);
      }

      return {
        parser,
        chunkableTypes: definition.chunkableTypes,
        childChunkTypes: definition.childChunkTypes,
        alwaysExtractChildren: definition.alwaysExtractChildren,
        isDocumentation: definition.isDocumentation,
        hooks: definition.hooks,
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
        return this.chunkMarkdownSimple(code, filePath, language);
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
      const nodes = this.findChunkableNodes(tree.rootNode, langConfig.chunkableTypes);

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
          const parentName = this.extractName(node, code);
          const parentType = node.type;

          const childNodes = this.findChildChunkableNodes(node, langConfig.childChunkTypes ?? []);

          // Filter to children that meet minimum size
          const validChildren = childNodes.filter((c) => code.substring(c.startIndex, c.endIndex).length >= 50);

          if (validChildren.length > 0) {
            // Run hook chain
            const ctx = createHookContext(node, validChildren, code, {
              maxChunkSize: this.config.maxChunkSize,
            });
            for (const hook of langConfig.hooks ?? []) {
              hook.process(ctx);
            }

            // Extract each child (method) as individual chunk
            for (let ci = 0; ci < validChildren.length; ci++) {
              const childNode = validChildren[ci];
              const childContent = code.substring(childNode.startIndex, childNode.endIndex);

              // If child is also too large, use character fallback
              if (childContent.length > this.config.maxChunkSize * 2) {
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
                    },
                  });
                }
                continue;
              }

              let finalContent = childContent.trim();
              let startLine = childNode.startPosition.row + 1;

              // Apply hook-provided prefix (e.g., preceding comments)
              const prefix = ctx.methodPrefixes.get(ci);
              if (prefix) {
                finalContent = `${prefix}\n${finalContent}`;
              }
              const overrideStart = ctx.methodStartLines.get(ci);
              if (overrideStart !== undefined) {
                startLine = overrideStart;
              }

              const childName = this.extractName(childNode, code);
              chunks.push({
                content: finalContent,
                startLine,
                endLine: childNode.endPosition.row + 1,
                metadata: {
                  filePath,
                  language,
                  chunkIndex: chunks.length,
                  chunkType: this.getChunkType(childNode.type),
                  name: childName,
                  parentName,
                  parentType,
                  symbolId: this.buildSymbolId(childName, parentName),
                },
              });
            }

            // Extract class-level code (everything outside methods) as body chunk(s)
            if (langConfig.alwaysExtractChildren) {
              const hasHookChain = langConfig.hooks && langConfig.hooks.length > 0;
              if (hasHookChain) {
                // Hook chain ran — use hook-provided body chunks (may be empty)
                for (const result of ctx.bodyChunks) {
                  chunks.push({
                    content: result.content,
                    startLine: result.startLine,
                    endLine: result.endLine,
                    metadata: {
                      filePath,
                      language,
                      chunkIndex: chunks.length,
                      chunkType: "block",
                      name: parentName,
                      parentName,
                      parentType,
                      symbolId: this.buildSymbolId(parentName),
                      lineRanges: result.lineRanges,
                    },
                  });
                }
              } else {
                // No hooks — generic fallback: single body chunk
                const bodyContent = this.extractContainerBody(node, validChildren, code);
                if (bodyContent && bodyContent.trim().length >= 50) {
                  chunks.push({
                    content: bodyContent.trim(),
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
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
            const subChunks = await this.fallbackChunker.chunk(content, filePath, language);
            for (const subChunk of subChunks) {
              chunks.push({
                ...subChunk,
                startLine: node.startPosition.row + 1 + subChunk.startLine - 1,
                endLine: node.startPosition.row + 1 + subChunk.endLine - 1,
                metadata: {
                  ...subChunk.metadata,
                  chunkIndex: chunks.length,
                  parentName,
                  parentType,
                },
              });
            }
            continue;
          }
          // alwaysExtractChildren but no valid children — fall through to single chunk
        }

        const nodeName = this.extractName(node, code);
        chunks.push({
          content: content.trim(),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          metadata: {
            filePath,
            language,
            chunkIndex: index,
            chunkType: this.getChunkType(node.type),
            name: nodeName,
            symbolId: this.buildSymbolId(nodeName),
          },
        });
      }

      // If no chunks found or file is small, use fallback
      if (chunks.length === 0 && code.length > 100) {
        return this.fallbackChunker.chunk(code, filePath, language);
      }

      return chunks;
    } catch (error) {
      // On parsing error, fallback to character-based chunking
      console.error(`Tree-sitter parsing failed for ${filePath}:`, error);
      return this.fallbackChunker.chunk(code, filePath, language);
    }
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
   * Remark-based markdown chunker using unified/mdast AST parser.
   * Uses remark (CommonMark/GFM parser) instead of tree-sitter due to
   * compatibility issues with tree-sitter-markdown grammar (requires tree-sitter 0.26+).
   *
   * Creates chunks for:
   * 1. Sections (heading + content until next heading of same/higher level)
   * 2. Fenced code blocks with language detection (for searching code examples)
   */
  private async chunkMarkdownSimple(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const lines = code.split("\n");

    // Parse markdown with remark (GFM for GitHub flavored markdown)
    const tree = remark().use(remarkGfm).parse(code);

    // Collect headings with positions
    interface HeadingInfo {
      depth: number;
      text: string;
      startLine: number;
      endLine: number;
      nodeIndex: number;
    }

    const headings: HeadingInfo[] = [];

    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i];
      if (node.type === "heading" && node.position) {
        // Extract text from heading children
        const text = this.extractTextFromMdastNode(node);
        headings.push({
          depth: node.depth,
          text,
          startLine: node.position.start.line,
          endLine: node.position.end.line,
          nodeIndex: i,
        });
      }
    }

    // Collect code blocks
    interface CodeBlockInfo {
      lang: string | undefined;
      value: string;
      startLine: number;
      endLine: number;
    }

    const codeBlocks: CodeBlockInfo[] = [];

    const collectCodeBlocks = (node: Content) => {
      if (node.type === "code" && node.position) {
        codeBlocks.push({
          lang: node.lang || undefined,
          value: node.value,
          startLine: node.position.start.line,
          endLine: node.position.end.line,
        });
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          collectCodeBlocks(child as Content);
        }
      }
    };

    for (const child of tree.children) {
      collectCodeBlocks(child);
    }

    // Create section chunks
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];

      // Find end of section (next heading of ANY level, or end of document)
      // This creates smaller, more focused chunks for semantic search
      let sectionEndLine = lines.length;
      if (i + 1 < headings.length) {
        sectionEndLine = headings[i + 1].startLine - 1;
      }

      // Extract section content from original code
      const sectionLines = lines.slice(heading.startLine - 1, sectionEndLine);
      const sectionContent = sectionLines.join("\n").trim();

      // Skip very small sections
      if (sectionContent.length < 50) {
        continue;
      }

      // If section is too large, split it
      if (sectionContent.length > this.config.maxChunkSize * 2) {
        const subChunks = await this.fallbackChunker.chunk(sectionContent, filePath, language);
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            startLine: heading.startLine + subChunk.startLine - 1,
            endLine: heading.startLine + subChunk.endLine - 1,
            metadata: {
              ...subChunk.metadata,
              chunkIndex: chunks.length,
              name: heading.text,
              parentName: heading.text,
              parentType: `h${heading.depth}`,
              isDocumentation: true,
            },
          });
        }
        continue;
      }

      chunks.push({
        content: sectionContent,
        startLine: heading.startLine,
        endLine: sectionEndLine,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: "block",
          name: heading.text,
          symbolId: heading.text,
          isDocumentation: true,
        },
      });
    }

    // Create code block chunks (for searching code examples in docs)
    for (const block of codeBlocks) {
      // Skip very small code blocks
      if (block.value.length < 30) {
        continue;
      }

      const codeBlockName = block.lang ? `Code: ${block.lang}` : "Code block";
      chunks.push({
        content: block.value,
        startLine: block.startLine + 1, // +1 to skip ``` line
        endLine: block.endLine - 1, // -1 to skip closing ```
        metadata: {
          filePath,
          // Use the code block's language, not "markdown"
          language: block.lang || "code",
          chunkIndex: chunks.length,
          chunkType: "block",
          name: codeBlockName,
          symbolId: codeBlockName,
          isDocumentation: true,
        },
      });
    }

    // Handle preamble (content before first heading)
    if (headings.length > 0 && headings[0].startLine > 1) {
      const preamble = lines
        .slice(0, headings[0].startLine - 1)
        .join("\n")
        .trim();
      if (preamble.length >= 50) {
        chunks.unshift({
          content: preamble,
          startLine: 1,
          endLine: headings[0].startLine - 1,
          metadata: {
            filePath,
            language,
            chunkIndex: 0,
            chunkType: "block",
            name: "Preamble",
            symbolId: "Preamble",
            isDocumentation: true,
          },
        });
        // Re-index all chunks
        for (let i = 1; i < chunks.length; i++) {
          chunks[i].metadata.chunkIndex = i;
        }
      }
    }

    // If no headings and no code blocks, treat whole document as one chunk
    if (chunks.length === 0 && code.length >= 50) {
      chunks.push({
        content: code.trim(),
        startLine: 1,
        endLine: lines.length,
        metadata: {
          filePath,
          language,
          chunkIndex: 0,
          chunkType: "block",
          isDocumentation: true,
        },
      });
    }

    return chunks;
  }

  /**
   * Extract text content from mdast node (handles nested inlines like emphasis, links, etc.)
   */
  private extractTextFromMdastNode(node: Content): string {
    if (node.type === "text") {
      return (node as { type: "text"; value: string }).value;
    }
    if ("children" in node && Array.isArray(node.children)) {
      return node.children.map((child: Content) => this.extractTextFromMdastNode(child)).join("");
    }
    return "";
  }

  /**
   * Find all chunkable nodes in the AST
   */
  private findChunkableNodes(node: Parser.SyntaxNode, chunkableTypes: string[]): Parser.SyntaxNode[] {
    const nodes: Parser.SyntaxNode[] = [];

    const traverse = (n: Parser.SyntaxNode) => {
      if (chunkableTypes.includes(n.type)) {
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
  private findChildChunkableNodes(parentNode: Parser.SyntaxNode, childChunkTypes: string[]): Parser.SyntaxNode[] {
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
  private extractContainerBody(
    containerNode: Parser.SyntaxNode,
    childNodes: Parser.SyntaxNode[],
    code: string,
  ): string | undefined {
    const containerStartRow = containerNode.startPosition.row;
    const containerEndRow = containerNode.endPosition.row;
    const lines = code.split("\n");

    // Build a set of line numbers occupied by child nodes (methods)
    const methodLines = new Set<number>();
    for (const child of childNodes) {
      for (let { row } = child.startPosition; row <= child.endPosition.row; row++) {
        methodLines.add(row);
      }
    }

    // Collect lines from the container that are NOT inside any method
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
   * Extract function/class name from AST node
   */
  private extractName(node: Parser.SyntaxNode, code: string): string | undefined {
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
  private getChunkType(nodeType: string): "function" | "class" | "interface" | "block" {
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

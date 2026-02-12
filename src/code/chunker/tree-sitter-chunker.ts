/**
 * TreeSitterChunker - AST-aware code chunking using tree-sitter
 * Primary chunking strategy for supported languages
 *
 * OPTIMIZATION: Lazy-loads parsers on first use to reduce startup time.
 * Before: All 9 parsers loaded at construction (~3-5 seconds)
 * After: Parsers loaded on demand (~0ms startup, ~100-200ms first use per language)
 */

import Parser from "tree-sitter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import type { Root, Heading, Code, Content } from "mdast";

import type { ChunkerConfig, CodeChunk } from "../types.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character-chunker.js";
import { RubyBodyGrouper, type BodyLine } from "./ruby-body-grouper.js";

interface LanguageDefinition {
  /** Function to load the language module (lazy) */
  loadModule: () => any;
  /** Function to extract language from module (some have nested structure) */
  extractLanguage?: (mod: any) => any;
  /** AST node types that should be chunked */
  chunkableTypes: string[];
  /**
   * Child types to look for when a chunkable node is too large.
   * If a class/module exceeds maxChunkSize, we recurse to find these smaller units.
   */
  childChunkTypes?: string[];
  /**
   * Always extract child chunks from container types (class/module) regardless of size.
   * In Ruby, methods are always inside classes/modules, so we must always extract them.
   * Without this, small classes become a single chunk and methods are not searchable.
   */
  alwaysExtractChildren?: boolean;
  /**
   * Flag to identify documentation languages (markdown, etc.)
   * Used for filtering search results by content type
   */
  isDocumentation?: boolean;
}

interface LanguageConfig {
  parser: Parser;
  chunkableTypes: string[];
  childChunkTypes?: string[];
  alwaysExtractChildren?: boolean;
  isDocumentation?: boolean;
}

/**
 * Language definitions - modules are NOT loaded until first use
 */
const LANGUAGE_DEFINITIONS: Record<string, LanguageDefinition> = {
  typescript: {
    loadModule: () => import("tree-sitter-typescript"),
    extractLanguage: (mod) => mod.default?.typescript || mod.typescript,
    chunkableTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
    ],
  },
  javascript: {
    loadModule: () => import("tree-sitter-javascript"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "export_statement",
    ],
  },
  python: {
    loadModule: () => import("tree-sitter-python"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["function_definition", "class_definition", "decorated_definition"],
  },
  go: {
    loadModule: () => import("tree-sitter-go"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: [
      "function_declaration",
      "method_declaration",
      "type_declaration",
      "interface_declaration",
    ],
  },
  rust: {
    loadModule: () => import("tree-sitter-rust"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["function_item", "impl_item", "trait_item", "struct_item", "enum_item"],
  },
  java: {
    loadModule: () => import("tree-sitter-java"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: [
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
    ],
  },
  bash: {
    loadModule: () => import("tree-sitter-bash"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["function_definition", "command"],
  },
  ruby: {
    loadModule: () => import("tree-sitter-ruby"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: [
      "method",            // def method_name ... end
      "singleton_method",  // def self.method_name ... end
      "class",             // class Foo ... end (small classes kept whole)
      "module",            // module Bar ... end (small modules kept whole)
      "singleton_class",   // class << self ... end
    ],
    // When class/module is too large, recursively look for these smaller units
    // NOTE: "singleton_class" removed from childChunkTypes - we traverse THROUGH it
    // to find the methods inside (class << self ... end contains methods)
    childChunkTypes: ["method", "singleton_method"],
    // In Ruby, virtually all code lives inside class/module. Without this flag,
    // small classes become a single chunk and individual methods are not searchable.
    alwaysExtractChildren: true,
    // Removed problematic types:
    // - "lambda", "block" → too small (1 line), fragments context
    // - "do_block" → creates too many tiny chunks from iterators
    // - "rescue" → loses protected code context
    // - "singleton_class" → we pass through it to find methods inside
  },
  markdown: {
    // Markdown uses remark parser (unified/mdast) instead of tree-sitter
    // due to compatibility issues with tree-sitter-markdown grammar (requires tree-sitter 0.26+)
    // Remark is a robust CommonMark/GFM parser used by VS Code, Gatsby, etc.
    loadModule: () => Promise.resolve(null),
    chunkableTypes: [],
    // Flag for documentation files - enables filtering in search API
    isDocumentation: true,
    // Skip tree-sitter parsing, use remark-based chunker
    skipTreeSitter: true,
  } as LanguageDefinition & { skipTreeSitter?: boolean },
};

export class TreeSitterChunker implements CodeChunker {
  /** Cache of initialized parsers (lazy-loaded) */
  private parserCache: Map<string, LanguageConfig> = new Map();
  private fallbackChunker: CharacterChunker;
  private rubyBodyGrouper = new RubyBodyGrouper();
  /** Track loading promises to avoid duplicate loads */
  private loadingPromises: Map<string, Promise<LanguageConfig | null>> = new Map();

  /**
   * Build symbolId from name and optional parentName
   * Format: "ParentName.childName" or just "name"
   */
  private buildSymbolId(name?: string, parentName?: string): string | undefined {
    if (!name) return undefined;
    return parentName ? `${parentName}.${name}` : name;
  }

  constructor(private config: ChunkerConfig) {
    this.fallbackChunker = new CharacterChunker(config);
    // NO parser initialization here - lazy load on demand!
  }

  /**
   * Get or lazily initialize parser for a language.
   * Returns null if language is not supported.
   */
  private async getLanguageConfig(language: string): Promise<LanguageConfig | null> {
    // Check cache first
    if (this.parserCache.has(language)) {
      return this.parserCache.get(language)!;
    }

    // Check if already loading (avoid duplicate loads)
    if (this.loadingPromises.has(language)) {
      return this.loadingPromises.get(language)!;
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
  private async initializeParser(
    language: string,
    definition: LanguageDefinition,
  ): Promise<LanguageConfig | null> {
    try {
      const startTime = Date.now();

      // Dynamic import of language module
      const mod = await definition.loadModule();
      const langModule = definition.extractLanguage
        ? definition.extractLanguage(mod)
        : mod.default || mod;

      // Create and configure parser
      const parser = new Parser();
      parser.setLanguage(langModule as any);

      if (process.env.DEBUG) {
        console.error(
          `[TreeSitter] Lazy-loaded ${language} parser in ${Date.now() - startTime}ms`,
        );
      }

      return {
        parser,
        chunkableTypes: definition.chunkableTypes,
        childChunkTypes: definition.childChunkTypes,
        alwaysExtractChildren: definition.alwaysExtractChildren,
        isDocumentation: definition.isDocumentation,
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

          const childNodes = this.findChildChunkableNodes(node, langConfig.childChunkTypes!);

          // Filter to children that meet minimum size
          const validChildren = childNodes.filter(
            (c) => code.substring(c.startIndex, c.endIndex).length >= 50,
          );

          if (validChildren.length > 0) {
            // Extract each child (method) as individual chunk
            for (const childNode of validChildren) {
              const childContent = code.substring(childNode.startIndex, childNode.endIndex);

              // If child is also too large, use character fallback
              if (childContent.length > this.config.maxChunkSize * 2) {
                const subChunks = await this.fallbackChunker.chunk(childContent, filePath, language);
                for (const subChunk of subChunks) {
                  chunks.push({
                    ...subChunk,
                    startLine: childNode.startPosition.row + 1 + subChunk.startLine - 1,
                    endLine: childNode.startPosition.row + 1 + subChunk.endLine - 1,
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

              const childName = this.extractName(childNode, code);
              chunks.push({
                content: childContent.trim(),
                startLine: childNode.startPosition.row + 1,
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

            // Extract class-level code (everything outside methods) as body chunk(s).
            // For Ruby: semantic grouping (associations, validations, scopes, etc.)
            // For other languages: single body chunk (existing behavior)
            if (langConfig.alwaysExtractChildren) {
              if (language === "ruby") {
                const bodyLines = this.extractContainerBodyLines(node, validChildren, code);
                const groups = this.rubyBodyGrouper.groupLines(bodyLines, this.config.maxChunkSize);
                const classHeader = this.extractClassHeader(node, code);

                for (const group of groups) {
                  const groupContent = group.lines.map((l) => l.text).join("\n").trim();

                  // Prepend class header for context
                  const contentWithContext = classHeader
                    ? `${classHeader}\n${groupContent}`
                    : groupContent;

                  // Check size after including header (header is part of the chunk)
                  if (contentWithContext.length < 50) continue;

                  // Use the group's actual line ranges for startLine/endLine
                  const minLine = Math.min(...group.lineRanges.map((r) => r.start));
                  const maxLine = Math.max(...group.lineRanges.map((r) => r.end));

                  chunks.push({
                    content: contentWithContext,
                    startLine: minLine,
                    endLine: maxLine,
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
              } else {
                // Non-Ruby: single body chunk (existing behavior)
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
    await Promise.all(languages.map((lang) => this.getLanguageConfig(lang)));
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
  private async chunkMarkdownSimple(
    code: string,
    filePath: string,
    language: string,
  ): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const lines = code.split("\n");

    // Parse markdown with remark (GFM for GitHub flavored markdown)
    const tree = remark().use(remarkGfm).parse(code) as Root;

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
          lang: (node as Code).lang || undefined,
          value: (node as Code).value,
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
        endLine: block.endLine - 1,     // -1 to skip closing ```
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
      const preamble = lines.slice(0, headings[0].startLine - 1).join("\n").trim();
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
  private findChunkableNodes(
    node: Parser.SyntaxNode,
    chunkableTypes: string[],
  ): Parser.SyntaxNode[] {
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
  private findChildChunkableNodes(
    parentNode: Parser.SyntaxNode,
    childChunkTypes: string[],
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
      for (let row = child.startPosition.row; row <= child.endPosition.row; row++) {
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
   * Extract body lines with original source line numbers.
   * Used by RubyBodyGrouper for semantic grouping with line tracking.
   */
  private extractContainerBodyLines(
    containerNode: Parser.SyntaxNode,
    childNodes: Parser.SyntaxNode[],
    code: string,
  ): BodyLine[] {
    const containerStartRow = containerNode.startPosition.row;
    const containerEndRow = containerNode.endPosition.row;
    const lines = code.split("\n");

    // Build a set of line numbers occupied by child nodes (methods)
    const methodLines = new Set<number>();
    for (const child of childNodes) {
      for (let row = child.startPosition.row; row <= child.endPosition.row; row++) {
        methodLines.add(row);
      }
    }

    // Collect non-method lines with their 1-based source line numbers.
    // Skip container boundaries (class/end lines) — the header is prepended separately.
    const bodyLines: BodyLine[] = [];
    for (let row = containerStartRow + 1; row < containerEndRow; row++) {
      if (!methodLines.has(row)) {
        bodyLines.push({
          text: lines[row],
          sourceLine: row + 1, // 1-based
        });
      }
    }

    return bodyLines;
  }

  /**
   * Extract class/module declaration line for context injection.
   * Returns "class Foo < Bar" or "module Baz" or undefined.
   */
  private extractClassHeader(
    node: Parser.SyntaxNode,
    code: string,
  ): string | undefined {
    const lines = code.split("\n");
    const firstLine = lines[node.startPosition.row];
    if (firstLine && /^\s*(class|module)\s+/.test(firstLine)) {
      return firstLine.trim();
    }
    return undefined;
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

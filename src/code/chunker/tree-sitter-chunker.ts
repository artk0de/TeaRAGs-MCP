/**
 * TreeSitterChunker - AST-aware code chunking using tree-sitter
 * Primary chunking strategy for supported languages
 *
 * OPTIMIZATION: Lazy-loads parsers on first use to reduce startup time.
 * Before: All 9 parsers loaded at construction (~3-5 seconds)
 * After: Parsers loaded on demand (~0ms startup, ~100-200ms first use per language)
 */

import Parser from "tree-sitter";

import type { ChunkerConfig, CodeChunk } from "../types.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character-chunker.js";

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
}

interface LanguageConfig {
  parser: Parser;
  chunkableTypes: string[];
  childChunkTypes?: string[];
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
    childChunkTypes: ["method", "singleton_method", "singleton_class"],
    // Removed problematic types:
    // - "lambda", "block" → too small (1 line), fragments context
    // - "do_block" → creates too many tiny chunks from iterators
    // - "rescue" → loses protected code context
  },
};

export class TreeSitterChunker implements CodeChunker {
  /** Cache of initialized parsers (lazy-loaded) */
  private parserCache: Map<string, LanguageConfig> = new Map();
  private fallbackChunker: CharacterChunker;
  /** Track loading promises to avoid duplicate loads */
  private loadingPromises: Map<string, Promise<LanguageConfig | null>> = new Map();

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
      };
    } catch (error) {
      console.error(`[TreeSitter] Failed to load parser for ${language}:`, error);
      return null;
    }
  }

  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
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

        // If chunk is too large, try AST-aware splitting first
        if (content.length > this.config.maxChunkSize * 2) {
          const parentName = this.extractName(node, code);
          const parentType = node.type;

          // Try to find smaller chunkable units inside (e.g., methods inside class)
          if (langConfig.childChunkTypes && langConfig.childChunkTypes.length > 0) {
            const childNodes = this.findChildChunkableNodes(node, langConfig.childChunkTypes);

            if (childNodes.length > 0) {
              // Found methods/functions inside - chunk them individually
              for (const childNode of childNodes) {
                const childContent = code.substring(childNode.startIndex, childNode.endIndex);

                // Skip if child is also too large (will be handled by character fallback)
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

                // Skip too small chunks
                if (childContent.length < 50) continue;

                chunks.push({
                  content: childContent.trim(),
                  startLine: childNode.startPosition.row + 1,
                  endLine: childNode.endPosition.row + 1,
                  metadata: {
                    filePath,
                    language,
                    chunkIndex: chunks.length,
                    chunkType: this.getChunkType(childNode.type),
                    name: this.extractName(childNode, code),
                    parentName,  // Keep class/module context
                    parentType,
                  },
                });
              }
              continue;
            }
          }

          // No child chunks found - fall back to character chunking
          const subChunks = await this.fallbackChunker.chunk(content, filePath, language);
          // Adjust line numbers for sub-chunks
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

        chunks.push({
          content: content.trim(),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          metadata: {
            filePath,
            language,
            chunkIndex: index,
            chunkType: this.getChunkType(node.type),
            name: this.extractName(node, code),
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

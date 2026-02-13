import type Parser from "tree-sitter";

import { rubyHooks } from "./hooks/ruby/index.js";
import type { ChunkingHook } from "./hooks/types.js";

export interface LanguageDefinition {
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
  /** Language-specific chunking hooks */
  hooks?: ChunkingHook[];
}

export interface LanguageConfig {
  parser: Parser;
  chunkableTypes: string[];
  childChunkTypes?: string[];
  alwaysExtractChildren?: boolean;
  isDocumentation?: boolean;
  hooks?: ChunkingHook[];
}

/**
 * Language definitions - modules are NOT loaded until first use
 */
export const LANGUAGE_DEFINITIONS: Record<string, LanguageDefinition> = {
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
    chunkableTypes: ["function_declaration", "method_definition", "class_declaration", "export_statement"],
  },
  python: {
    loadModule: () => import("tree-sitter-python"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["function_definition", "class_definition", "decorated_definition"],
  },
  go: {
    loadModule: () => import("tree-sitter-go"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["function_declaration", "method_declaration", "type_declaration", "interface_declaration"],
  },
  rust: {
    loadModule: () => import("tree-sitter-rust"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["function_item", "impl_item", "trait_item", "struct_item", "enum_item"],
  },
  java: {
    loadModule: () => import("tree-sitter-java"),
    extractLanguage: (mod) => mod.default || mod,
    chunkableTypes: ["method_declaration", "class_declaration", "interface_declaration", "enum_declaration"],
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
      "method", // def method_name ... end
      "singleton_method", // def self.method_name ... end
      "class", // class Foo ... end (small classes kept whole)
      "module", // module Bar ... end (small modules kept whole)
      "singleton_class", // class << self ... end
    ],
    // When class/module is too large, recursively look for these smaller units
    // NOTE: "singleton_class" removed from childChunkTypes - we traverse THROUGH it
    // to find the methods inside (class << self ... end contains methods)
    childChunkTypes: ["method", "singleton_method"],
    // In Ruby, virtually all code lives inside class/module. Without this flag,
    // small classes become a single chunk and individual methods are not searchable.
    alwaysExtractChildren: true,
    hooks: rubyHooks,
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

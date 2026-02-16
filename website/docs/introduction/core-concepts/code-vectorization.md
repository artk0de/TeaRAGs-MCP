---
title: Code Vectorization
sidebar_position: 2
---

Code vectorization transforms your source code into searchable vector embeddings, enabling:

- **Natural language search** — ask questions about your code in plain English
- **Semantic understanding** — find code by intent, not just keywords
- **Cross-language search** — find similar patterns across different languages
- **Git-aware context** — understand authorship, code age, and task history

## The Indexing Pipeline

### 1. File Discovery

The indexer scans your project respecting:
- `.gitignore` patterns
- `.contextignore` patterns (project-specific overrides)
- Built-in exclusions (node_modules, vendor, etc.)

### 2. AST-Aware Chunking

Code is intelligently split using language-aware parsers (tree-sitter). Each chunk preserves semantic boundaries — functions, classes, methods — rather than splitting at arbitrary line counts.

| Language | Parser | Features |
|----------|--------|----------|
| TypeScript/JavaScript | tree-sitter | Classes, functions, interfaces, types, imports |
| Python | tree-sitter | Classes, functions, decorators, async |
| Ruby | tree-sitter | Classes, modules, methods, Rails DSL groups |
| Go | tree-sitter | Structs, functions, interfaces |
| Java/C#/C++ | tree-sitter | Classes, methods, namespaces |
| Rust | tree-sitter | Structs, impl blocks, traits |
| PHP | tree-sitter | Classes, functions, traits |
| Markdown | remark | Sections, code blocks |
| Others | Line-based | Fallback chunking with configurable size |

Each chunk carries:
- **Semantic boundaries** — functions, classes, methods stay intact
- **Parent context** — `parentName`, `parentType` for nested code (e.g., method inside a class)
- **Location info** — file path, start/end line numbers
- **Language metadata** — for filtering by language
- **Symbol ID** — unique identifier like `MyClass.processData`

### 3. Vector Embedding

Chunks are converted to vectors using your configured embedding provider:

| Provider | Type | Privacy | Best For |
|----------|------|---------|----------|
| **Ollama** (recommended) | Local | Full — code never leaves your machine | Production, privacy-sensitive |
| **OpenAI** | Cloud | API | Quick setup |
| **Cohere** | Cloud | API | General text |
| **Voyage AI** | Cloud | API | Code-specialized models |

### 4. Storage in Qdrant

Vectors are stored in Qdrant with full metadata payloads (file path, language, chunk type, parent info, git metadata). Payload indexes enable fast filtered search.

### 5. Incremental Indexing

After initial indexing, `reindex_changes` detects:
- **Added files** — new files since last index
- **Modified files** — changed content (content-hash based detection)
- **Deleted files** — removed files

Only affected chunks are updated. Hash-based change detection uses a two-level Merkle tree with consistent hashing across sharded snapshots, enabling fast diff computation even for large codebases.

## Quick Start

```bash
# Index your codebase
# Ask your agent: "Index this codebase for semantic search"

# Update after changes
# Ask your agent: "Reindex changes in this project"
```

For detailed configuration (chunk sizes, batch sizes, custom extensions, ignore patterns), see [Configuration](/config/environment-variables) and [Indexing Repositories](/usage/indexing-repositories).

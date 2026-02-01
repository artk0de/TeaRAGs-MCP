# Code Vectorization

Comprehensive guide to indexing and searching codebases with semantic code search.

## Overview

Code vectorization transforms your source code into searchable vector embeddings, enabling:

- **Natural language search** - ask questions about your code in plain English
- **Semantic understanding** - find code by intent, not just keywords
- **Cross-language search** - find similar patterns across different languages
- **Git-aware context** - understand authorship, code age, and task history

## Quick Start

```bash
# Index your codebase
/mcp__qdrant__index_codebase /path/to/your/project

# Search your code
/mcp__qdrant__search_code /path/to/your/project "authentication middleware"

# Update after changes
/mcp__qdrant__reindex_changes /path/to/your/project
```

## How It Works

### 1. File Discovery

The indexer scans your project respecting:
- `.gitignore` patterns
- `.contextignore` patterns (project-specific overrides)
- Built-in exclusions (node_modules, vendor, etc.)

### 2. AST-Aware Chunking

Code is intelligently split using language-aware parsers:

| Language | Parser | Features |
|----------|--------|----------|
| TypeScript/JavaScript | tree-sitter | Classes, functions, imports |
| Python | tree-sitter | Classes, functions, decorators |
| Ruby | tree-sitter | Classes, modules, methods |
| Go | tree-sitter | Structs, functions, interfaces |
| Java/C#/C++ | tree-sitter | Classes, methods, namespaces |
| Markdown | remark | Headers, sections, code blocks |
| Others | Line-based | Fallback chunking |

Each chunk preserves:
- **Semantic boundaries** - functions, classes, methods
- **Parent context** - `parentName`, `parentType` for nested code
- **Location info** - file path, line numbers
- **Language metadata** - for filtering

### 3. Git Metadata Enrichment

When `CODE_ENABLE_GIT_METADATA=true`:

```typescript
{
  // Blame data (per chunk, based on line coverage)
  authors: ["alice@example.com", "bob@example.com"],
  lastModified: "2025-01-15T10:30:00Z",
  commitCount: 12,
  codeAge: 45,  // days since oldest line

  // Task IDs extracted from commit messages
  taskIds: ["PROJ-123", "GH-456"],
}
```

**Task ID patterns detected:**
- JIRA: `PROJ-123`, `ABC-1`
- GitHub: `#123`, `GH-123`
- Azure DevOps: `AB#123`
- GitLab: `!123`, `GL-123`

### 4. Vector Embedding

Chunks are converted to vectors using your configured embedding provider:

- **Ollama** (recommended) - local, private, no API costs
- **OpenAI** - `text-embedding-3-small/large`
- **Cohere** - `embed-english-v3.0`
- **Voyage** - `voyage-code-2` (code-specialized)

### 5. Incremental Indexing

After initial indexing, `reindex_changes` detects:
- **Added files** - new files since last index
- **Modified files** - changed content (hash-based detection)
- **Deleted files** - removed files

Only affected chunks are updated, making re-indexing fast.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CODE_CHUNK_SIZE` | Maximum chunk size in characters | 2500 |
| `CODE_CHUNK_OVERLAP` | Overlap between chunks | 300 |
| `CODE_ENABLE_AST` | Use AST-aware chunking | true |
| `CODE_BATCH_SIZE` | Chunks per embedding batch | 100 |
| `CODE_CUSTOM_EXTENSIONS` | Additional file extensions | - |
| `CODE_CUSTOM_IGNORE` | Additional ignore patterns | - |
| `CODE_DEFAULT_LIMIT` | Default search result count | 5 |
| `CODE_ENABLE_GIT_METADATA` | Enable git blame enrichment | false |

### File Filtering

#### Using .contextignore

Create a `.contextignore` file in your project root:

```gitignore
# Exclude test files from indexing
**/test/**
**/*.test.ts
**/*.spec.ts

# Exclude generated code
*.generated.ts
**/dist/**

# Exclude specific directories
**/fixtures/**
**/mocks/**
```

#### Custom Extensions

```bash
# Add non-standard file types
export CODE_CUSTOM_EXTENSIONS=".proto,.graphql,.prisma"
```

## Search Features

### Basic Search

```bash
/mcp__qdrant__search_code /path/to/project "how does authentication work?"
```

### Filtered Search

```bash
# By file type
/mcp__qdrant__search_code /path "error handling" --fileTypes .ts,.tsx

# By path pattern
/mcp__qdrant__search_code /path "validation" --pathPattern src/api/**

# By author (requires git metadata)
/mcp__qdrant__search_code /path "recent changes" --author alice@example.com

# Documentation only (markdown files)
/mcp__qdrant__search_code /path "setup instructions" --documentationOnly true
```

### Hybrid Search

Combines semantic understanding with keyword matching:

```bash
/mcp__qdrant__search_code /path "getUserById function" --hybrid true
```

Best for:
- Function/variable names
- Error messages
- Technical terms

## Supported Languages

### Full AST Support

| Language | Extensions | Features |
|----------|------------|----------|
| TypeScript | `.ts`, `.tsx` | Classes, functions, interfaces, types |
| JavaScript | `.js`, `.jsx`, `.mjs` | Classes, functions, exports |
| Python | `.py` | Classes, functions, decorators, async |
| Ruby | `.rb` | Classes, modules, methods, blocks |
| Go | `.go` | Structs, functions, interfaces |
| Java | `.java` | Classes, methods, interfaces |
| C# | `.cs` | Classes, methods, namespaces |
| C/C++ | `.c`, `.cpp`, `.h` | Functions, structs, classes |
| Rust | `.rs` | Structs, impl blocks, traits |
| PHP | `.php` | Classes, functions, traits |
| Markdown | `.md` | Sections, code blocks |

### Line-Based Fallback

All other text files use intelligent line-based chunking with configurable size and overlap.

## Best Practices

### 1. Optimize Chunk Size

| Codebase Type | Recommended Size | Overlap |
|---------------|-----------------|---------|
| Small functions | 1500-2000 | 200 |
| Large classes | 3000-4000 | 400 |
| Documentation | 2000-2500 | 300 |

### 2. Use Incremental Updates

Always use `reindex_changes` after initial indexing:

```bash
# First time: full index
/mcp__qdrant__index_codebase /path/to/project

# Subsequent: incremental only
/mcp__qdrant__reindex_changes /path/to/project
```

### 3. Filter Aggressively

Exclude noise from indexing:

```gitignore
# .contextignore
**/vendor/**
**/node_modules/**
**/*.min.js
**/*.bundle.js
**/coverage/**
**/.git/**
```

### 4. Choose the Right Embedding Model

| Use Case | Recommended Model |
|----------|-------------------|
| General code search | `nomic-embed-text` |
| Code-specialized | `jina-embeddings-v2-base-code` |
| Multilingual code | `jina-embeddings-v2-base-code` |
| Maximum accuracy | `voyage-code-2` |

### 5. Monitor Index Status

```bash
# Check before searching
/mcp__qdrant__get_index_status /path/to/project
```

## Use Cases

### New Developer Onboarding

```bash
/mcp__qdrant__search_code /workspace/app "authentication flow"
/mcp__qdrant__search_code /workspace/app "database connection setup"
/mcp__qdrant__search_code /workspace/app "API endpoint structure"
```

### Bug Investigation

```bash
/mcp__qdrant__search_code /workspace/app "payment error handling"
/mcp__qdrant__search_code /workspace/app "retry logic" --pathPattern src/services/**
```

### Code Review

```bash
/mcp__qdrant__search_code /workspace/app "validation patterns"
/mcp__qdrant__search_code /workspace/app "security checks"
```

### Documentation Writing

```bash
/mcp__qdrant__search_code /workspace/app "public API methods"
/mcp__qdrant__search_code /workspace/app "configuration options"
```

## Troubleshooting

### Search Returns No Results

1. Check index status: `/mcp__qdrant__get_index_status /path`
2. Verify files are not ignored
3. Try broader, more natural queries

### Slow Indexing

1. Use local Ollama instead of cloud providers
2. Increase `CODE_BATCH_SIZE`
3. Exclude large/binary files

### Memory Issues

1. Reduce `CODE_CHUNK_SIZE`
2. Reduce `CODE_BATCH_SIZE`
3. Index subdirectories separately

See also: [Performance Tuning](./PERFORMANCE_TUNING.md)

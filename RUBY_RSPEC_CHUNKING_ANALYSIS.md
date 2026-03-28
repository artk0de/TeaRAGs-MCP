# Ruby/RSpec Chunking Infrastructure Analysis

## Overview

The tea-rags-mcp system uses a sophisticated, multi-stage hook-based
architecture for chunking Ruby code, with special support for RSpec test files.
The pipeline processes Ruby files through four sequential hooks that collaborate
via a shared `HookContext` to produce semantically meaningful code chunks.

---

## 1. How Ruby Files Are Chunked

### Architecture Layers

**File:** `/src/core/domains/ingest/pipeline/chunker/config.ts`

Ruby is configured in `LANGUAGE_DEFINITIONS` with:

```typescript
ruby: {
  loadModule: async () => import("tree-sitter-ruby"),
  chunkableTypes: [
    "method", "singleton_method", "class", "module",
    "singleton_class", "call"
  ],
  childChunkTypes: ["method", "singleton_method", "call"],
  alwaysExtractChildren: true,
  hooks: rubyHooks,
  nameExtractor: (node, code) => { ... }
}
```

**Key Configuration Details:**

- `alwaysExtractChildren: true` — Ruby classes/modules ALWAYS extract their
  child methods as separate chunks, even if small. This ensures methods inside
  classes are individually searchable rather than buried in a large class chunk.
- `childChunkTypes: ["method", "singleton_method", "call"]` — When recursing
  into a container, look for these three types.
- `nameExtractor` — Custom function extracts names from `call` nodes (RSpec DSL
  calls like `describe`, `context`, `it`). For example: `describe User do` →
  extracts "describe User".

### Chunking Pipeline Flow

**File:** `/src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` → `chunk()`
method

The TreeSitterChunker processes Ruby files in this order:

1. **Parse AST** — tree-sitter-ruby parses the file into an AST.
2. **Find Chunkable Nodes** — Traverse AST looking for types in
   `chunkableTypes`.
3. **Consult Filter Hooks** — For each candidate node, call `hook.filterNode()`
   to include/exclude.
4. **Check if Container** — If node is a class/module (containers), extract
   children:
   - Find all child methods/calls inside the container.
   - Create a `HookContext` with the container node and valid children.
   - **Run Hook Chain** (4 sequential hooks in
     `/src/core/domains/ingest/pipeline/chunker/hooks/ruby/`):
     1. `rspecFilterHook` — Filters call nodes to only RSpec DSL methods.
     2. `rubyCommentCaptureHook` — Collects comments preceding methods.
     3. `rspecScopeChunkerHook` — (RSpec files only) Groups specs by scope
        hierarchy.
     4. `rubyBodyChunkingHook` — Groups non-method class-body code by semantic
        type.
   - **Process Children** — Extract each valid child as an individual chunk.
5. **Extract Body Chunks** — Class-level code (non-method declarations) becomes
   separate chunk(s).
6. **Merge Small Chunks** — Post-processing: merge adjacent tiny chunks to
   reduce noise.

---

## 2. How RSpec Chunks Get Their chunkType

### RSpec Detection

**File:** `/src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-filter.ts`

```typescript
export function isRspecFile(filePath: string): boolean {
  return filePath.endsWith("_spec.rb") || /(^|[/\\])spec[/\\]/.test(filePath);
}
```

A file is considered RSpec if:

- Filename ends with `_spec.rb` (e.g., `user_spec.rb`), OR
- Path contains `/spec/` directory (e.g., `spec/models/user_spec.rb`)

### RSpec DSL Method Classification

**File:** `/src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-filter.ts`

```typescript
const RSPEC_CONTAINER_METHODS = new Set([
  "describe",
  "context",
  "feature",
  "shared_examples",
  "shared_context",
  "shared_examples_for",
]);

const RSPEC_EXAMPLE_METHODS = new Set([
  "it",
  "specify",
  "example",
  "scenario",
  "its",
  "xit",
  "xspecify",
  "xexample",
  "fit",
  "fspecify",
  "fexample",
]);
```

The `rspecFilterHook` has two functions:

1. **filterNode()** — Rejects non-RSpec calls:
   - Returns `false` for non-RSpec files → all `call` nodes rejected.
   - Returns `false` for non-RSpec DSL methods in RSpec files (e.g.,
     `my_custom_method`).
   - Returns `false` for "shoulda one-liners" (tiny tests like
     `it { is_expected.to ... }`).
   - Returns `true` for recognized RSpec DSL methods.

2. **Shoulda One-Liner Detection** → Prevents chunking of tiny assertions:
   ```typescript
   function isShouldaOneLiner(node, code, methodName): boolean {
     // Detect: it { ... } (brace block, no string arg)
     // Keep: it 'x' { ... } (has description string)
   }
   ```

### RSpec Scope Chunking

**File:**
`/src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`

When an RSpec file is detected, the `rspecScopeChunkerHook` runs and **takes
over all chunking** by:

1. **Building a Scope Tree** — Walks the AST recursively to create a hierarchy
   of scopes:
   - Container methods: `describe`, `context`, `feature`, `shared_examples`,
     `shared_context`
   - Example methods: `it`, `specify`, `example`, `xit`, `fit`, etc.
   - Setup methods: `let`, `let!`, `subject`, `before`, `after`, `around`,
     `include_context`, `it_behaves_like`, `include_examples`

2. **Assigning chunkType** based on scope contents:

   **For Leaf Scopes (no nested contexts):**

   ```typescript
   if (scope.isLeaf) {
     if (scope.ownItBlocks.length > 0) {
       // Has `it` blocks → "test" chunk
       chunkType = "test";
     } else if (scope.setupLines.length > 0 || scope.otherLines.length > 0) {
       // Only setup/config, no `it` blocks → "test_setup" chunk
       chunkType = "test_setup";
     }
   }
   ```

   **For Intermediate Scopes (have nested contexts):**

   ```typescript
   if (!scope.isLeaf) {
     // Recurse into children
     for (const child of scope.children) {
       walk(child, [...ancestors, scope]);
     }

     // If intermediate scope ALSO has its own `it` blocks:
     if (scope.ownItBlocks.length > 0) {
       chunkType = "test_setup"; // Intermediate scopes with tests = "test_setup"
     }
   }
   ```

3. **Setting symbolId** as 2-level hierarchy:

   ```typescript
   symbolId = `${topLevelName}.${scope.name}`;
   // e.g., "UserController.when_admin" or "AuthService.valid_token"
   ```

4. **Including Inherited Setup** — Parent scope setup flows down:

   ```typescript
   function collectParentSetup(scope, ancestors): string[] {
     const parts = [];
     for (const ancestor of ancestors) {
       for (const setup of ancestor.setupLines) {
         parts.push(setup.text);
       }
     }
     return parts;
   }
   ```

   Each chunk includes setup from all ancestor scopes, making each test chunk
   self-contained with full context.

5. **Handling describe/context/shared_examples blocks**:

   All these are treated the same way in the tree:
   - `describe User do ... end` → scope name = "describe User"
   - `context 'when admin' do ... end` → scope name = "context 'when admin'"
   - `shared_examples 'validates' do ... end` → scope name = "shared_examples
     'validates'"

---

## 3. How methodLines is Computed for Chunks

**File:** `/src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` → `chunk()`
method

### For Regular Method Chunks

```typescript
chunks.push({
  content: ...,
  startLine: node.startPosition.row + 1,
  endLine: this.computeEndLine(node),
  metadata: {
    methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
  }
});

private computeEndLine(node: Parser.SyntaxNode): number {
  return Math.max(node.startPosition.row + 2, node.endPosition.row + 1);
}
```

**Calculation:**

- `startLine` = tree-sitter `startPosition.row + 1` (convert 0-based to 1-based)
- `endLine` = `Math.max(startPosition.row + 2, endPosition.row + 1)`
  - Ensures single-line nodes span at least 2 lines (minimum 1 line content)
  - Multi-line nodes use the actual end position
- `methodLines` = `endLine - startLine`
  - This is the **line span** of the method (inclusive count)

### For Class/Module Body Chunks

**File:**
`/src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts`

Body chunks compute line ranges from the grouped lines:

```typescript
function computeLineRanges(
  lines: BodyLine[],
): { start: number; end: number }[] {
  // Group consecutive source lines into ranges
  // E.g., [5, 6, 7, 10, 11] → [{start: 5, end: 7}, {start: 10, end: 11}]
}

const minLine = Math.min(...group.lineRanges.map((r) => r.start));
const maxLine = Math.max(...group.lineRanges.map((r) => r.end));
// startLine and endLine are derived from lineRanges min/max
```

### For RSpec Test Chunks

**File:**
`/src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`

For leaf scopes with test blocks:

```typescript
const allLines = [
  ...scope.setupLines.map((s) => s.sourceLine),
  ...scope.otherLines.map((o) => o.sourceLine),
  ...scope.ownItBlocks.flatMap((b) => [b.startLine, b.endLine]),
];
// Include parent setup lines in range
for (const ancestor of ancestors) {
  for (const setup of ancestor.setupLines) {
    allLines.push(setup.sourceLine);
  }
}
const startLine =
  allLines.length > 0
    ? Math.min(...allLines)
    : scope.node.startPosition.row + 1;
const endLine =
  allLines.length > 0 ? Math.max(...allLines) : scope.node.endPosition.row + 1;
```

**Key Point:** `methodLines` is **NOT explicitly set** in RSpec chunks because
they come from `ctx.bodyChunks` (hook-provided), and the tree-sitter chunker
doesn't add `methodLines` metadata to hook results.

---

## 4. How startLine/endLine Are Determined — Parent Scope Injection

### Parent Scope Injection in startLine

Yes, there **IS parent scope injection** that can inflate line ranges:

**File:** `/src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` →
`processChildren()` method

When extracting children (methods inside a class), the line computation includes
hierarchy context:

```typescript
// Leaf child — emit as chunk with hierarchy context
let finalContent = childContent.trim();
let startLine = childNode.startPosition.row + 1;

const prefix = ctx.methodPrefixes.get(ci);  // Comment prefix from hook
if (prefix) {
  finalContent = `${prefix}\n${finalContent}`;
}
const overrideStart = ctx.methodStartLines.get(ci);  // Override from hook
if (overrideStart !== undefined) {
  startLine = overrideStart;  // Use overridden start line (includes comments)
}

// Prepend hierarchy headers for context
if (hierarchyHeaders.length > 0) {
  const hierarchyPrefix = this.buildHierarchyPrefix(hierarchyHeaders);
  finalContent = `${hierarchyPrefix}${finalContent}`;
}

chunks.push({
  content: finalContent,
  startLine,  // Potentially overridden by hooks
  endLine: this.computeEndLine(childNode),
  ...
});
```

### Mechanism of Parent Scope Injection

1. **Comment Capture Hook** captures comment lines above methods:

   ```typescript
   // File: comment-capture.ts
   ctx.methodStartLines.set(i, sorted[0] + 1); // Earliest comment line
   ctx.methodPrefixes.set(i, commentText);
   ```

   This adjusts `startLine` to include preceding comments as part of the method
   chunk.

2. **RSpec Scope Injection** — includes parent setup in line ranges:

   ```typescript
   // File: rspec-scope-chunker.ts
   const allLines = [...setupLines, ...otherLines, ...itBlockLines];
   for (const ancestor of ancestors) {
     allLines.push(...ancestor.setupLines.map((s) => s.sourceLine));
   }
   const startLine = Math.min(...allLines); // Pulls start back to include parent setup
   ```

3. **Hierarchy Headers Prepend** (RSpec nested describes):
   ```typescript
   if (hierarchyHeaders.length > 0) {
     const hierarchyPrefix = this.buildHierarchyPrefix(hierarchyHeaders);
     finalContent = `${hierarchyPrefix}${finalContent}`;
   }
   ```
   This PREPENDS parent scope lines in the content (for context) but does NOT
   change `startLine` for the child. The parent line numbers are assumed to be
   already included by setup collection.

### Example: Comment-inflated Line Range

```ruby
# This is a comment
# spanning two lines
def my_method
  puts "hello"
end
```

Tree-sitter sees `def my_method` at line 3.

- Default startLine would be 3
- Comment capture hook adjusts it to 1 (the first comment line)
- Final chunk startLine = 1, endLine = 5

### Example: RSpec Scope Inflation

```ruby
describe 'User' do        # Line 1
  let(:user) { User.new } # Line 2 (setup)

  context 'when admin' do # Line 4
    let(:role) { :admin }  # Line 5 (nested setup)

    it 'can edit' do       # Line 7 (it block)
      expect(...).to eq(true)
    end
  end
end
```

When chunking the `it 'can edit'` block:

- Node spans lines 7-9
- Scope (when_admin) has setupLine at line 5
- Ancestors include root describe scope with setupLine at line 2
- allLines = [2, 5, 7, 8, 9]
- **startLine = 2** (pulled back to include all parent setup)
- **endLine = 9**
- Content includes inherited setup from both parent scopes

---

## 5. How test_setup chunkType is Assigned vs Regular test Chunks

### Assignment Logic

**File:**
`/src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`

The distinction is made in `produceScopeChunks()`:

#### LEAF SCOPE (no nested contexts):

```typescript
if (scope.isLeaf) {
  if (scope.ownItBlocks.length > 0) {
    // Has it blocks
    chunkType = "test"; // ← Regular test chunk
  } else if (scope.setupLines.length > 0 || scope.otherLines.length > 0) {
    // Only setup/config, NO it blocks
    chunkType = "test_setup"; // ← Setup-only chunk
  }
}
```

#### INTERMEDIATE SCOPE (has nested contexts):

```typescript
if (!scope.isLeaf) {
  // Recurse into children first
  for (const child of scope.children) {
    walk(child, [...ancestors, scope]);
  }

  // If THIS intermediate scope ALSO has it blocks (tests at this level + children):
  if (scope.ownItBlocks.length > 0) {
    chunkType = "test_setup"; // ← Always "test_setup" for intermediate scopes
  }
}
```

### Key Distinction

| Condition                                         | chunkType    | Meaning                                                    |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| Leaf scope + has `it` blocks                      | `test`       | A leaf test group with actual test cases                   |
| Leaf scope + NO `it` blocks, but has setup/before | `test_setup` | Setup code without tests (e.g., shared setup in a context) |
| Intermediate scope + has `it` blocks              | `test_setup` | Tests at multiple levels (can't be a pure "test")          |
| Intermediate scope + no `it` blocks               | (skipped)    | Never chunks intermediate with no content                  |

### Content Composition for test_setup

```typescript
// For test_setup chunks:
const setupParts = scope.setupLines.map((s) => s.text); // let, before, subject
const otherParts = scope.otherLines.map((o) => o.text); // misc code
const itParts = scope.ownItBlocks.map((b) => b.text); // it blocks (if any)

const content = [...setupParts, ...otherParts, ...itParts].join("\n").trim();
chunkType =
  scope.ownItBlocks.length > 0 && scope.isLeaf ? "test" : "test_setup";
```

### Example: Distinguishing test vs test_setup

**Example 1: Leaf scope with tests**

```ruby
describe 'User' do
  let(:user) { User.new }    # setup

  describe '#valid?' do       # nested describe (not a leaf)
    context 'with name' do    # leaf scope
      it 'is valid' do        # ← it block
        expect(user.valid?).to be true
      end
    end
  end
end
```

→ Chunk for `with name` scope = **"test"** (leaf + has it block)

**Example 2: Leaf scope without tests**

```ruby
describe 'User' do
  context 'setup' do         # leaf scope
    let(:user) { User.new }  # ← setup only, no it blocks
  end

  context 'validates name' do  # leaf scope
    it 'requires name' do
      expect { User.new }.to raise_error
    end
  end
end
```

→ Chunk for `setup` scope = **"test_setup"** (leaf + no it blocks)

**Example 3: Intermediate scope with tests**

```ruby
describe 'UserService' do     # intermediate (has nested contexts)
  let(:service) { UserService.new }

  it 'initializes' do         # ← it block at intermediate level
    expect(service).to_not be_nil
  end

  context 'validation' do      # nested (child) context
    it 'validates name' do
      expect { service.validate }.to raise_error
    end
  end
end
```

→ Chunk for `UserService` scope = **"test_setup"** (intermediate + has it
blocks)

---

## Summary Table

| Aspect                       | Location                 | Details                                                                                       |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| **Ruby Detection**           | `config.ts`              | Chunkable types: method, class, module, call; alwaysExtractChildren: true                     |
| **RSpec Filter**             | `rspec-filter.ts`        | isRspecFile() checks `_spec.rb` suffix or `/spec/` path; filterNode() accepts DSL methods     |
| **Container Classification** | `rspec-filter.ts`        | Container methods: describe, context, feature, shared_examples, shared_context                |
| **Example Classification**   | `rspec-filter.ts`        | Example methods: it, specify, example, xit, fit (rejects shoulda one-liners)                  |
| **Setup Methods**            | `rspec-scope-chunker.ts` | let, let!, subject, before, after, around, include_context, it_behaves_like, include_examples |
| **chunkType Assignment**     | `rspec-scope-chunker.ts` | Leaf+it="test", Leaf+setup="test_setup", Intermediate+it="test_setup"                         |
| **symbolId Format**          | `rspec-scope-chunker.ts` | 2-level: `${topLevelName}.${scopeName}`                                                       |
| **methodLines Compute**      | `tree-sitter.ts`         | endLine - startLine; for RSpec, NOT set (hook-provided chunks)                                |
| **Parent Setup Injection**   | `rspec-scope-chunker.ts` | Ancestor setup included in allLines → startLine pulled back to earliest setup                 |
| **Comment Injection**        | `comment-capture.ts`     | collectMethodCommentRows() overrides methodStartLines via ctx.methodStartLines                |
| **Body Chunking**            | `class-body-chunker.ts`  | Groups non-method code by Rails keyword (associations, validations, scopes, callbacks, etc.)  |

---

## Hook Pipeline Execution Order

**File:** `/src/core/domains/ingest/pipeline/chunker/hooks/ruby/index.ts`

```typescript
export const rubyHooks: ChunkingHook[] = [
  rspecFilterHook, // 1. filterNode: reject non-RSpec calls
  rubyCommentCaptureHook, // 2. Populate excludedRows + methodStartLines
  rspecScopeChunkerHook, // 3. RSpec: build scopes, set ctx.bodyChunks, skipChildren=true
  rubyBodyChunkingHook, // 4. Non-RSpec: group class body by keyword
];
```

1. **rspecFilterHook.filterNode()** is called during node discovery to
   accept/reject.
2. **rubyCommentCaptureHook.process()** runs first (before scope chunker) to
   extract comments.
3. **rspecScopeChunkerHook.process()** for RSpec files: builds scope tree,
   populates ctx.bodyChunks, sets skipChildren=true to prevent child emission.
4. **rubyBodyChunkingHook.process()** for non-RSpec files: groups class body
   code semantically.

The hook chain runs ONCE per container (class/module/describe block), with ctx
mutable state shared across all hooks.

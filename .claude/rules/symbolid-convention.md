---
paths:
  - "src/core/domains/ingest/pipeline/chunker/**"
  - "src/core/domains/trajectory/codegraph/**"
---

# symbolId Convention (MANDATORY)

A single project-wide convention defines how chunks and graph rows label a
method's identity. The chunker (writing Qdrant payload `symbolId`) and the
codegraph provider (writing `cg_symbols.symbol_id` in DuckDB) MUST agree on the
output for the same physical AST node. Mismatches produce silent ghost rows —
`get_callers`/`get_callees` look up by the codegraph form but the user copies
the chunker form from a search result, and vice versa.

## The rule (cross-language, no exceptions)

| symbolId form  | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `name`         | Top-level function, top-level class, or unscoped symbol.             |
| `Class#method` | **Instance method**. Invoked on an instance (`obj.method()`).        |
| `Class.method` | **Class / static / abstract method**. Invoked on the class itself.   |
| `Outer::Inner` | Ruby `::` and Rust `::` — namespace separator. NOT an instance hint. |
| `Outer.Nested` | Nested class declaration in TS/JS/Python. NOT an instance hint.      |

Reading the form:

- `#` between class and member → instance method (binds to `this`/`self`).
- `.` between class and member → class-level (static / classmethod / abstract /
  associated function).
- `::` only appears in languages whose namespace separator is `::` (Ruby
  modules/classes, Rust modules/types). Methods STILL use `#` / `.` —
  `Acme::User#save` for an instance method on `Acme::User`.

## Per-language detection

The same detection logic powers BOTH the chunker
(`chunker/tree-sitter.ts:isStaticMethod`) and the codegraph
(`codegraph/symbols/provider.ts:<lang>NameOf` returning `instanceMethod`). Keep
them in lockstep when adding a language.

| Language       | Instance method                                       | Class / static method                                               |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| **TypeScript** | `method_definition` without `static` keyword          | `method_definition` with `static` keyword                           |
| **JavaScript** | Same as TypeScript (shared `method_definition` shape) | Same as TypeScript                                                  |
| **Python**     | `function_definition` inside class, no decorator      | `function_definition` decorated with `@classmethod`/`@staticmethod` |
| **Ruby**       | `method` (`def foo`)                                  | `singleton_method` (`def self.foo`)                                 |
| **Go**         | `method_declaration` (has a receiver)                 | `function_declaration` (top-level — gets `name` form, no parent)    |
| **Java**       | `method_declaration` without `static` in modifiers    | `method_declaration` with `static` in modifiers                     |
| **Rust**       | `function_item` with a `self` / `&self` parameter     | `function_item` without `self` (associated function)                |
| **Bash**       | n/a (no class concept — only top-level functions)     | n/a                                                                 |

Constructors are instance-bound (`Class#constructor`) per convention — they
initialize an instance even though they're invoked via `new Class()`.

## Where the convention is implemented

- `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
  - `buildSymbolId(name, parentName, isStatic)` — picks `#` vs `.`
  - `isStaticMethod(node)` — per-language detection dispatched by node type
- `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  - `joinSymbol(composed, child, scopeSeparator)` — composes fqName using `#`
    when `child.instanceMethod === true`, otherwise the language's
    `scopeSeparator`
  - `<lang>NameOf(node)` — returns `NamedSymbol` with `instanceMethod` flag
- `src/core/domains/trajectory/codegraph/symbols/resolvers/<lang>/<lang>-resolver.ts`
  - For `this.X()` / `super.X()` calls, target id is
    `${enclosingClass}#${call.member}` (instance form). Static dispatch via
    `this.staticHelper` falls through to the `.` form lookup.

## When you add a new language

1. Add `<lang>NameOf` in `provider.ts` that returns
   `{ name, descendsInto, instanceMethod }`. Set `instanceMethod: true` on the
   AST node types that represent instance method declarations for the language.
2. Extend `isStaticMethod(node)` in `chunker/tree-sitter.ts` with the matching
   per-language branch — the chunker writes the Qdrant payload symbolId and MUST
   agree with the codegraph DB.
3. Update `<lang>-resolver.ts` to use the `#`/`.` forms when constructing
   intra-class fqNames (mirror `ts-resolver.ts`).
4. Add a row to the "Per-language detection" table above.
5. Cover the convention in tests:
   - `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts` —
     instance + class method emit different separators
   - `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts` — both
     forms reach cg_symbols with the right separator
   - `tests/core/domains/trajectory/codegraph/symbols/resolvers/<lang>/<lang>-resolver.test.ts`
     — `this.X()` resolves to `Class#X`, `Class.staticX()` resolves to
     `Class.staticX`

## Anti-patterns

- **Don't use `.` as a catch-all separator.** Method calls between class and
  member need the `#`/`.` distinction or `get_callers` returns the wrong row.
- **Don't try to "fix" symbolIds at query time.** The chunker and codegraph both
  PERSIST the symbolId — fixing it after the fact means rewriting both Qdrant
  payload and cg_symbols rows. Get the persistence right.
- **Don't introduce a third separator** (e.g. `::` for static methods to "make
  it more readable"). One project, two separators between class and member: `#`
  and `.`. Anything else is a bug.
- **Don't hardcode per-language separator outside the two files listed above.**
  If you find yourself writing `join("#")` or `join(".")` in a resolver, a
  derived signal, an explore strategy, or a stats accumulator — back out and add
  a helper that consults the canonical detection logic.

## Verification checklist

Before merging a change that touches symbolId composition:

1. `npx vitest run tests/core/domains/ingest/pipeline/chunker` — chunker
   produces the expected separator per language.
2. `npx vitest run tests/core/domains/trajectory/codegraph` — codegraph produces
   the same separator for the same physical AST node.
3. Live MCP check on the tea-rags self-test (see
   `.claude/skills/test-self-reindex/SKILL.md`): pick an instance method,
   confirm it appears as `Class#method` in BOTH
   `find_symbol(symbol: "Class#method")` payload AND
   `get_callers(symbolId: "Class#method")` returns non-empty when called by at
   least one other symbol in the same file.

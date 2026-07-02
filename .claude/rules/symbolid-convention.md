---
paths:
  - "src/core/domains/ingest/pipeline/chunker/**"
  - "src/core/domains/trajectory/codegraph/**"
---

# symbolId Convention (MANDATORY)

Single project-wide convention defines how chunks + graph rows label method
identity. Chunker (writes Qdrant payload `symbolId`) + codegraph provider
(writes `cg_symbols.symbol_id` in DuckDB) MUST agree on output for same physical
AST node. Mismatch → silent ghost rows: `get_callers`/`get_callees` look up by
codegraph form but user copies chunker form from search result, and vice versa.

## The rule (cross-language, no exceptions)

| symbolId form  | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `name`         | Top-level function, top-level class, or unscoped symbol.             |
| `Class#method` | **Instance method**. Invoked on an instance (`obj.method()`).        |
| `Class.method` | **Class / static / abstract method**. Invoked on the class itself.   |
| `Outer::Inner` | Ruby `::` and Rust `::` — namespace separator. NOT an instance hint. |
| `Outer.Nested` | Nested class declaration in TS/JS/Python. NOT an instance hint.      |

Reading the form:

- `#` between class and member → instance method (binds `this`/`self`).
- `.` between class and member → class-level (static / classmethod / abstract /
  associated function).
- `::` only in languages whose namespace separator is `::` (Ruby
  modules/classes, Rust modules/types). Methods STILL use `#` / `.` —
  `Acme::User#save` for instance method on `Acme::User`.

## Per-language detection

Same detection logic powers BOTH chunker
(`chunker/tree-sitter.ts:isStaticMethod`) + codegraph
(`codegraph/symbols/provider.ts:<lang>NameOf` returning `instanceMethod`). Keep
lockstep when adding language.

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

Constructors instance-bound (`Class#constructor`) per convention — initialize an
instance even though invoked via `new Class()`.

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

1. Add `<lang>NameOf` in `provider.ts` returning
   `{ name, descendsInto, instanceMethod }`. Set `instanceMethod: true` on the
   AST node types representing instance method declarations for the language.
2. Extend `isStaticMethod(node)` in `chunker/tree-sitter.ts` with matching
   per-language branch — chunker writes Qdrant payload symbolId, MUST agree with
   codegraph DB.
3. Update `<lang>-resolver.ts` to use `#`/`.` forms when constructing
   intra-class fqNames (mirror `ts-resolver.ts`).
4. Add row to "Per-language detection" table above.
5. Cover convention in tests:
   - `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts` —
     instance + class method emit different separators
   - `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts` — both
     forms reach cg_symbols with the right separator
   - `tests/core/domains/trajectory/codegraph/symbols/resolvers/<lang>/<lang>-resolver.test.ts`
     — `this.X()` resolves to `Class#X`, `Class.staticX()` resolves to
     `Class.staticX`

## Anti-patterns

- **Don't use `.` as catch-all separator.** Method calls between class and
  member need `#`/`.` distinction or `get_callers` returns wrong row.
- **Don't "fix" symbolIds at query time.** Chunker + codegraph both PERSIST the
  symbolId — fixing after the fact means rewriting both Qdrant payload +
  cg_symbols rows. Get persistence right.
- **Don't introduce third separator** (e.g. `::` for static methods to "make
  more readable"). One project, two separators between class and member: `#` and
  `.`. Anything else = bug.
- **Don't hardcode per-language separator outside the two files listed above.**
  Writing `join("#")` or `join(".")` in a resolver, derived signal, explore
  strategy, or stats accumulator — back out, add helper consulting canonical
  detection logic.

## Verification checklist

Before merging change touching symbolId composition:

1. `npx vitest run tests/core/domains/ingest/pipeline/chunker` — chunker
   produces expected separator per language.
2. `npx vitest run tests/core/domains/trajectory/codegraph` — codegraph produces
   same separator for same physical AST node.
3. Live MCP check on tea-rags self-test (see
   `.claude/skills/test-self-reindex/SKILL.md`): pick instance method, confirm
   appears as `Class#method` in BOTH `find_symbol(symbol: "Class#method")`
   payload AND `get_callers(symbolId: "Class#method")` returns non-empty when
   called by at least one other symbol in same file.

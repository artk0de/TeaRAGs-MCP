# Research questions — question → call

Index of all routing guides: `tea-rags://guide/decision-tree`. Analytics / risk
questions (tech debt, hotspots, owners, what not to touch) → guide
`skill-choice`.

Research / planning question (understand X before a change, map an area, answer
a design question) → find its row, run that call; never `ls` / `cat` / `grep` /
`git ls-files` to explore. After the first hit: how it works →
`get_callees(symbolId:)`, who uses it → `get_callers(symbolId:)` (id from the
row); what is needed at once → ONE `find_symbol(symbols: [...])` — the ids an
answer NAMED (member ids when known) and several files, never a dir (area/dir →
`find_symbol(relativePath:)` outline first); a 2nd search needs a new noun.
Config, DSL, routes, migrations, specs and files outside the index → the default
code read tool (core routing row 1). Architecture diagnostics is only for an
explicit diagnostic request, explicit skill invocation or structural
refactoring; never gather context with it.

| Question                                                                     | Call                                                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Explicit diagnosis of layer/dependency violations, or structural refactoring | `architecture-diagnostics` → `get_architecture_report(pathPattern: "<dir>/**")`                          |
| What implements contract / port / base `<P>`                                 | `find_symbol(symbol: "<P>")` → `get_callers` + `hybrid_search(query: "<P>", metaOnly: true)`             |
| Where `<X>` is registered / resolved / configured / flagged                  | `hybrid_search(query: "<X> register config flag", metaOnly: true)` → `find_symbol(symbols: [<hit ids>])` |
| Which models / tables back `<X>`                                             | `hybrid_search(query: "<X> model", metaOnly: true)`; schema / migrations outside the index → DB row      |
| Does table / column `<c>` exist, `create_table`, DB schema                   | default code search tool over `db/` (literal) — see DB note                                              |
| What the existing provider / impl does for `<W>`                             | `find_symbol(symbol: "<Impl>#<method>")`                                                                 |
| How does `<A>` reach `<B>`, riskiest step                                    | `find_symbol` ids → `trace_path(rerank: "dangerous")`; one hop → `get_callers`                           |
| Where do we do `<X>` (code may use other words)                              | `hybrid_search(query: "<X>")`; what it touches → `rerank: "blastRadius"`                                 |
| What was done under ticket `<T>`                                             | `semantic_search(query: "<topic>", taskId: "<T>", level: "chunk", metaOnly: true)` — see ticket note     |
| Who calls `<X>` before I change it                                           | `find_symbol(symbol: "<X>")` → `get_callers`                                                             |

**DB note.** The schema file first (`schema.rb`, `structure.sql`), else
`db/migrate/`; try both `:<t>` and `"<t>"` forms before claiming absence. Never
`semantic_search` on model names — models declare no columns.

**Ticket note.** Rows = chunks whose own commits carry `<T>`, each with its
`git.chunk.taskIds` → ONE `find_symbol(symbols: [<touched ids>])`. A ticket id
lives in commit messages, never in source: no text search for it.

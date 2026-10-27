# Navigation — after any search

Read before finishing any search. Routing + invariants: `tea-rags://guide/core`.

## Principles

**Chunk is the source of truth — for languages with full AST chunking.** Results
carry code + metadata (git signals ride a `rerank`). Don't re-read files to
"verify" or "understand"; `find_symbol` returns full method body / class outline
(ids to drill) — no `Read`. Holds where `tea-rags://guide/language-capability`
rates **AST = full** (native: ts/js/python/go/java/rust/ruby/ bash). For **AST =
none** (sql/jsonc/json + any non-native on CharacterChunker) a chunk may split a
symbol mid-body — there `Read` is legit fallback for exact code; markdown is
**partial** (section-level, fine for docs). `Read` always allowed to MODIFY —
never _needed_ to gather code for a full-AST language.

**`#partN` = fragment, never the unit of reasoning (MANDATORY).** Result
`symbolId` ends `#partN` (or `name` says `part i/N`) → oversized symbol, split
at the cap. One part lacks the rest of the body: branches, loop tails, returns,
calls. BEFORE interpreting it — ranking it, judging risk, quoting behavior,
editing — call `find_symbol(symbol: result.parentSymbolId)` once: merges every
part into the whole method. A `metaOnly` row carries no `parentSymbolId`: the
parent id is the `symbolId` with `#partN` cut off. Several parts of one symbol
in one result set = one symbol, one fetch; count it once in any tally or overlap
across presets.

**Code is evidence, docs are hypothesis.** Doc chunks (`.md`, `isDocumentation`)
carry intent + navigation (why / what-for) — NOT behavior truth. Behavioral
claim from doc chunk entering final answer → verify against code FIRST
(`find_symbol` / `hybrid_search`). Conflict → code wins; flag drift explicitly
("docs say X, code does Y"). Questions ABOUT docs themselves (README content,
doc TOC) — doc is the subject, no verification needed. Tests = executable spec
(what system SHOULD do); src↔test conflict → report both facts. Axis roles +
broad-search splitting: `rules/references/axis-splitting.md`.

## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)

**First search rarely returns a complete answer.** A chunk shows where the
symbol lives — not the whole picture. Before synthesizing from a single chunk,
ask: _need full body / file structure / a neighbor / doc sections?_ If yes —
next call is `find_symbol`, NOT another search, NOT `Read`. `find_symbol` is
instant (no embedding), returns merged definitions, file outlines, or doc TOCs
from the same index.

**Results are a table** `{ columns, rows }` from two results on (one result: a
plain record list; record arrays in text tools too): `result.X` below = column
`payload.X` of that row; overlay = column `rankingOverlay.chunk.<signal>.label`;
null = absent. Shape: `tea-rags://guide/overview` `## Response shape`.

**Answer carries `truncated`** (12k-token response budget hit) → rows are
partial: run `truncated.next` verbatim or narrow by a knob its `message` names;
never re-run the same call (`tea-rags://guide/pagination`).

| After search returns…                       | If you need…                            | Next call                                                                                                                                 |
| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Chunk with method body truncated            | Full method body                        | `find_symbol(symbol: result.symbolId)`                                                                                                    |
| Chunk whose `symbolId` ends in `#partN`     | The whole oversized symbol, reassembled | `find_symbol(symbol: result.parentSymbolId)` — collapses every `#partN` + base window into one (do NOT treat one part as the full symbol) |
| Chunk from one file                         | File structure / other methods in file  | `find_symbol(relativePath: result.relativePath)` → synthetic outline                                                                      |
| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                     | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`                                                                            |
| Chunk that calls a helper / class           | The helper / class definition           | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text                                                                     |
| Chunk from a `.md` doc                      | All sections of that doc (TOC)          | `find_symbol(relativePath: result.relativePath)` — heading TOC; doc `parentSymbolId` = doc path, NOT a hash                               |
| Just a doc path (no search yet)             | Table of contents of that doc           | `find_symbol(relativePath: "docs/file.md")` — heading TOC with hashes                                                                     |
| Class chunk (constructor or one method)     | All methods / public API of the class   | `find_symbol(symbol: "ClassName")` → OUTLINE: member ids, NO bodies, tests excluded → drill member                                        |
| Outline / TOC in hand (class, file, doc)    | One member / section                    | `find_symbol(symbol: <id from that line, verbatim>)` — every outline line = address. NOT `Read`, NOT grep                                 |
| 2+ ids in hand (outline lines, hits)        | Their bodies / sections                 | ONE `find_symbol(symbols: [<id1>, <id2>, ...])` (≤ 20) — rows keyed by `request`, misses in `missing[]`; never one call per id            |
| A directory path                            | Its files, their top-level symbols      | `find_symbol(relativePath: "<dir>")` — `directory` frame with subdirs; NOT `ls`, NOT a glob listing                                       |
| Answer carries `next` (search, find_symbol) | Callees / callers / co-change of anchor | each `next[i]` call verbatim, in order, before any new search — `project` + `path` already set; its `why` names the file and what it adds |
| Result saved to file (too large)            | Anything inside it                      | NEVER grep / `Read` the dump — ids from preview → `find_symbol(symbol: <id>)`; no id → `find_symbol(relativePath:)` outline first         |
| Class name, need its tests                  | Specs / test scopes of that class       | `hybrid_search(query: "ClassName", testFile: "only")` — class outline carries no tests                                                    |
| Chunk from production src + diff context    | Tests describing affected scenarios     | `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk`                                                                                 |
| Describe-it scope name from a stacktrace    | The failing scope and its examples      | `find_symbol(symbol: "<Top>.<scope>")` — OUTLINE of example ids (`<Top>.<scope>.<example>`); older index: merged leaf scope chunk         |
| Test example id (from an outline / result)  | That example with inherited setup       | `find_symbol(symbol: "<Top>.<scope>.<example>")` — one example chunk, `#partN` windows merged; repeated descriptions carry `~N`           |

`find_symbol` accepts a `rerank` preset for single-call diagnostic (definition +
rankingOverlay in one call). `offset` pagination works on every search tool;
when a page is exhausted, retry with `offset: N` instead of inflating `limit`.

**symbolId conventions (LANGUAGE-AGNOSTIC — same `#`/`.` rule for every
language; input contract for `find_symbol(symbol:)`):**

- Code instance methods: `Class#method` (e.g., `Reranker#rerank`) — bound to
  `this`/`self`. Constructors are instance-bound too (`Class#constructor`).
- Code static / class / classmethod / associated methods: `Class.method` (e.g.,
  `Reranker.create`)
- Top-level functions: `functionName` (no class prefix)
- Namespace separators are NOT a method hint: Ruby/Rust `::` (`Acme::User`) and
  TS/JS/Python nested-class `.` (`Outer.Nested`) only scope the container —
  methods on them still use `#`/`.` (`Acme::User#save`).
- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results

The `#`/`.` separator matters for EXACT lookup only. `find_symbol` and
`get_callers` retry a wrong separator through a `#`↔`.` swap: the row's
`symbolId` (`get_callers`: `resolvedSymbolId`) is the real id — carry it into
every later call. Still empty → `empty.reason` names the next step
(`tea-rags://guide/pagination` "Empty answers"), not a stale index. Irrelevant
for `hybrid_search`'s `symbolId` (partial substring match — pass a bare name).
When unsure instance vs static, pass a **partial match** to `find_symbol`
(`Class` alone, or bare `method`) and read the real separator off
`result.symbolId`; never downgrade an empty `find_symbol` to text search.
Producer-side source of truth (how separator chosen per language at index time):
`.claude/rules/symbolid-convention.md` (`INSTANCE_METHOD_SEPARATOR` in
`primitives/ids/symbolid/classify.ts`).

### find_symbol — the navigation workhorse (two addressing modes)

`find_symbol` is instant (no embedding), answers most "now show me X"
follow-ups. Choose mode by what you hold:

**Mode A — `symbol:` (you know the name)**

| You have…                                         | Pass                              | You get                                                   |
| ------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| Instance method                                   | `symbol: "Class#method"`          | merged full method body                                   |
| Static method / top-level fn                      | `symbol: "Class.method"` / `"fn"` | merged full definition                                    |
| **Class or module name**                          | `symbol: "ClassName"`             | OUTLINE: member ids, NO bodies, tests excluded            |
| Existence check only                              | `symbol: "X", metaOnly: true`     | presence + location, no body (cheapest)                   |
| Doc section (hash from a result)                  | `symbol: "doc:<hash>"`            | full section content (split parts merged)                 |
| Test scope id                                     | `symbol: "<Top>.<scope>"`         | OUTLINE: example ids, NO bodies                           |
| 2+ ids of any kind above (never file / dir paths) | `symbols: ["<id1>", "<id2>"]`     | one row per hit keyed by `request`; misses in `missing[]` |

**Mode B — `relativePath:` (you have a file or directory path) — USE THIS
MORE.** With no symbol, just a path. Agents under-use it; it is the correct
route, not `Read`, not `ls` / a glob listing, not `semantic_search`:

- **`relativePath: "docs/file.md"` → the doc's heading TOC** (one hash per
  heading). THE way to map a markdown doc before reading it. Whenever a task
  touches a `.md` doc and you lack a `doc:<hash>`, start here.
- **`relativePath: "src/foo.ts"` → file structure**: every class/method/function
  outline in that file. Use instead of `Read` to answer "what's in this file". A
  small code file answers with its full text (`kind: "file"`) — that IS the
  read, no `Read` after it.
- **`relativePath: "src/foo/"` (a directory) → its files, each with its
  top-level symbols, plus the subdirs** (`directory` frame). Use instead of `ls`
  / glob to answer "what's in this directory"; drill a file next.
- Unknown path → `empty.reason: "unknownPath"` + nearest `suggestions` — retry
  with one of them.

**Outline / TOC = map, not content — read chapters by address.** Every line of
class outline, file outline, doc TOC carries id (`Class#method`, `Class.method`,
`doc:<hash>`). Content needed → `find_symbol(symbol: <that id verbatim>)`;
several chapters → ONE `find_symbol(symbols: [<ids verbatim>])`, never one call
per chapter. Never answer from outline as if it held bodies. Never `Read` file
or grep saved tool-output dump to find a member — ids already in hand. Member
line may end in declared visibility — `Class#helper (private)` (see "Declared
visibility" below); suffix not part of id — drop before drilling.

### Graph navigation — get_callers / get_callees / trace_path

Requires codegraph. **Availability signal:** graph tools present in the tool
list = codegraph on; unsure →
`tea-rags://project/<alias>/metrics?section=registry`. Off → the graph tools
(`get_callers`, `get_callees`, `find_cycles`, `trace_path`,
`get_architecture_report`) are **not registered** — never appear in tool list.
Off-signal is an _absent tool_, not an empty result; check the tool list first
rather than calling a tool to discover it's missing. Precedence — start cheap,
escalate only if needed:

1. **`get_callers` / `get_callees`** — ONE hop ("who calls X" / "what X calls").
   Default for impact, dependency and "how does X work" questions; instant, no
   traversal. Pass `symbolId` for call edges — a search row's `symbolId` as-is;
   a typed `Class#method` → `find_symbol` first (an unknown id answers
   `empty.reason: "unknownSymbol"` + `suggestions`) — OR `relativePath` (imports
   only, never call edges) (repo-relative file, no `symbolId`) for FILE scope:
   `get_callers` → `importers[]` (files importing it), `get_callees` →
   `imports[]` (files it imports), each with `importText` + `callWeight`,
   heaviest first. These are THE import-edge reads: a search row's `imports` is
   a count (`includeImports: true` returns the raw lists). Unknown path →
   `empty.reason: "unknownFile"` + `message`, not a fact about the file.
2. **`find_cycles`** — detect circular dependency chains. Codegraph on + empty
   result IS the answer: "no cycles in <scope> → DAG" — no other tool to
   confirm.
3. **`trace_path`** — ALL paths A→B. Lean by default (path enumeration only);
   pass `rerank="bugHunt"` (or `dangerous`/`hotspots`/`blastRadius`) to attach
   per-step danger ranking. Escalate here ONLY when the full chain matters ("how
   does control reach B from A?", "which step on the A→B chain is riskiest?"),
   never for a single hop. Nodes are file-scoped — namesakes in different files
   never merge, paths never cross a namesake file boundary. Bare `from`/`to`
   matching >1 file → trace fans out from EVERY candidate; response carries
   `namesakes: { from: [...], to: [...] }` (PRE-filter candidate files; omitted
   when both endpoints unambiguous). Narrow with `fromPath` / `toPath` — exact
   relativePath, take it from a prior search result. Wrong path → `paths: []` +
   `namesakes` listing real candidates: disambiguation cue, NOT absence-of-path.

**Model edges.** A `get_callers` / `get_callees` entry with `origin: "model"`
was added by residual resolution (Kev) and carries `model` and `p`. Treat it as
probabilistic: weigh `p`, never as compiler truth. Entries without `origin` are
static. `trace_path` steps carry the same `origin`/`model`/`p` on a model hop
and each path a `minP` (its weakest link); `find_cycles` marks a cycle
`hasModelEdge` + `modelEdgeCount`. Prime's resolve rate counts the sites model
edges resolve; the `static` share beside it is the floor the static edges alone
guarantee.

**Declared visibility.** `get_callees` targets, `get_callers` callers (+ queried
symbol as top-level `visibility`), `trace_path` steps, find_symbol outline lines
carry DECLARED level when codegraph knows it. `private` → callers confined to
declaring class (Go: package, Swift: file) — local blast radius; `protected` →
class + subclasses; `public` → run `get_callers` for blast radius.
TS/Java/Swift/Rust/Go: compiler-enforced. Ruby (`send`), Python (`_x`
convention, only `__x` marked): hint, not guarantee. **Missing field = unknown**
— never read as public.

**When codegraph is off** (stated, or no graph tool seen AND the
`metrics?section=registry` codegraph line says off), route by intent to a
non-graph substitute — never read an absent/empty graph tool as positive fact
(no "it's a DAG", no "path structurally impossible", no "architectural centre"):

| Graph intent        | Non-codegraph fallback                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| who calls / X calls | client's standard code search tool `"<name>"` (literal) + `find_symbol` — name-match, NOT edge truth |
| call path A→B       | `semantic_search` / `hybrid_search` + manual reading; say plainly "no static path tool"              |
| cycles              | none — cycle detection NEEDS codegraph; say so, do NOT claim "no cycles / it's a DAG"                |
| layout / SDP        | none — architecture report NEEDS codegraph; say so, do NOT claim "no violations"                     |
| architectural hubs  | git imports/churn rerank or relevance; say fan-in centrality is unavailable                          |
| entry points        | relevance + `chunkSize` heuristic; flag results as content-inferred, not graph-confirmed             |

### Optimal routes (navigate, don't re-search)

- After ANY search → next call is `find_symbol`, never another search, never
  `Read`. The chunk already names the symbol/path you need.
- Doc structure → `find_symbol(relativePath: "docs/x.md")`, never `Read` the md.
- Class API → `find_symbol(symbol: "ClassName")` = outline (ids, no bodies);
  bodies → ONE `find_symbol(symbols: [<member ids>])` for all members needed.
- Who-uses-X repo-wide → the client's standard code search tool `"<X>"`
  (literal) when codegraph off; `get_callers` (exact, graph) AND that search
  when codegraph on.

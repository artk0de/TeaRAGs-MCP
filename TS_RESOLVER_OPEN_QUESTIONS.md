# TS resolver — open questions / what needs further investigation

Surfaced by the 2026-06-06 probe (real `CodegraphEnrichmentProvider` sink over
tea-rags 586 files + markdownlint-mcp 59 files). The same-file resolution pass
(`tea-rags-mcp-n444`, shipped) closed the bare-call / `new X()` / `Class.static`
same-file tail. This file lists what must be **investigated before** the next
program tasks (epic `tea-rags-mcp-ba9u`) can be specced precisely. These are
unknowns, not yet implementation tasks.

## Metric baseline (so deltas are comparable)

- In-repo resolveSuccessRate = `resolved / (resolved + addressable-miss)` where
  addressable-miss = unresolved call whose `member` short-name exists in the
  symbol table. Raw `resolveSuccessRate` is **style-dependent** (dominated by
  the external-call ratio: ~84% of unresolved are stdlib/npm and correctly
  unresolved) — do NOT use it as the gate.
- tea-rags: ~0.77 → **~0.83** after n444 (3557 resolved / 740 addressable miss).
- markdownlint: addressable miss 17 → **0**.
- Remaining tea-rags addressable tail (740): var/param/field 342, chained 325,
  bare-call 52, Class.static 14, this 3, constructor 4.

## Q1 — Walker scope convention for nested functions (blocks T-MEASURE trust)

The same-file pass resolved markdownlint's `getHeadingLevel` (defined nested
inside a rule function) — so nested local functions ARE in the symbol table and
matched the `relPath===callerFile` filter. Confirm the exact convention: does a
function nested in a function get `scope=[]` or `scope=[<enclosing fn>]`? This
determines whether the bare-call branch's "any same-file short-name" filter is
correct or accidentally over-broad. Document in `symbolid-convention.md`.

## Q2 — Does the walker capture `implements` (prereq for interface→impl, ezli)

`classExtends`/`classAncestors` capture `extends`. The biggest addressable
bucket (var/param/field 342) is largely interface→impl ambiguity
(`embeddings.checkHealth()`, `EmbeddingProvider` with 6 implementers). CHA
fan-out needs a queryable TS **class+interface hierarchy** including
`implements` edges and a reverse implementers index. Audit: does the walker emit
`implements` at all today? If not, that extraction is the real P0 (analogue of
Ruby `tea-rags-mcp-f10y`).

## Q3 — Concrete-type binding coverage audit (prereq for 2yfi)

Part of the 342 is NOT interface ambiguity but concrete-class-typed
locals/params the walker simply didn't bind (`registry.list()`,
`registry: CollectionRegistry`). Audit which annotation forms
`localBindings`/`classFieldTypes`/`functionReturnTypes` capture vs miss:
annotated params, `const x: T`, field decls, `x = new T()`, destructuring,
declared return types, `as T` casts. Quantify how much of 342 is
concrete-binding (deterministic, single target) vs interface (needs fan-out) —
split the bucket before committing to either mechanism.

## Q4 — Sub-classify the chained/complex bucket (scopes 9vf3)

325 chained misses (`ctx.app.x()`, `this.pending.get()`). Unknown split between
in-repo intermediate types (resolvable with multi-hop inference) vs external
(`Map`/`Promise`/`Array` methods, correctly unresolved). Run a sub-probe that
classifies the intermediate receiver type before deciding multi-hop is worth the
cost — it may be mostly external (low value).

## Q5 — Cross-file-not-imported bare-call tail (52) — barrel/re-export gap?

The residual bare-call tail returns CONTINUE under same-file. Hypothesis: some
are functions imported via a **barrel/re-export** where `mapImportToFile`
resolves the import to the barrel file but the definition lives in the
re-exported file → `namedImport`/`importNarrowedFallback` miss. Investigate
re-export resolution; may be a small deterministic win independent of the type
ladder.

## Q6 — Promote the probe harness to a real-chunker metric (T-MEASURE, 6x6e)

The throwaway probe used an APPROXIMATE chunker (function/method/class only),
not the production worker chunker. Confirm production chunk boundaries don't
shift resolution materially before trusting absolute numbers. The promoted
harness (`tea-rags-mcp-6x6e`) should drive the real provider sink and assert
addressable-miss ceilings as a regression gate — this is the metric backbone for
every other task in the program.

## Out of scope (not in this program)

interface→impl and multi-hop are bounded by the syntactic ceiling; full type
resolution needs LSP/type-checker integration (speculative, stays under
`tea-rags-mcp-l26` / Slice 9 `jw9n`). ~runtime-dynamic receivers (`obj[k]()`,
reflective construction) are never syntactically resolvable.

---

Program epic: `tea-rags-mcp-ba9u`. Mirrors Ruby program `tea-rags-mcp-cai0`.
Shipped baseline: `tea-rags-mcp-n444` (same-file resolution pass).

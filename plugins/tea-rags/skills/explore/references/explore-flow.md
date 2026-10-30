# Explore flow — broad scope, axis split, depth

Use for an explicitly broad system/domain introduction. Reuse retained evidence
and select only steps needed for that request; a directory name or snippet alone
does not require this workflow. Point questions do not need it.

## Flow

```
[broad scope? → ORIENT (entry points)] → BREADTH (search) →
  pick interesting results →
  LATERAL (find_similar) — same pattern elsewhere?
  DEPTH (find_symbol) — trace specific symbol?
→ explain to developer
```

## ORIENT (broad scope ONLY)

A typed path → SKILL.md BREADTH "Path typed first" (outline first; ORIENT /
BREADTH add after it).

**Gate by target.** System / domain / directory ("introduce me to the project",
"full picture of X", "walk me through domain Y") → ORIENT first. Named symbol /
narrow question ("what does Reranker#rerank do", "where is X used") → SKIP to
BREADTH (Scope extraction still runs; its pathPattern rides on BREADTH).

Architecture phrasing never reaches here — codegraph row 4 catches it;
architecture-pattern.md Step 0 runs same orientation.

Entry points = flow skeleton; see them BEFORE breadth so results land on a map.

- **Codegraph on** (graph tools in tool list):
  `semantic_search rerank="entryPoint" pathPattern=<scope> metaOnly:true limit:5`
  — graph-confirmed composition roots (fanOutPerLine↑, fanIn↓). Overlay shows
  `fanIn` / `fanOut` / `imports`.
- **Codegraph off**:
  `semantic_search rerank="onboarding" pathPattern=<scope> metaOnly:true limit:5`
  — stable + documented + mature files. FLAG as content-inferred, NOT
  graph-confirmed.
- Small / flat scope (no clear driver) → say ranking degraded; never present
  utility as "the entry point".

ORIENT provides a map; continue only if requested facts remain unsupported.
Explicit "entry point" INTENT ("where does X start") → codegraph row 3, not
here.

## Broad BREADTH — split axes

Select relevant axes; a broad question does not automatically require all three.
When more than one is needed, separate them per
`../../../rules/references/axis-splitting.md` (never `language` as axis proxy):

1. sources FIRST — `testFile: "exclude", documentation: "exclude"`
2. tests — `testFile: "only"` when coverage/expected behavior is requested or
   uncertain
3. docs — `documentation: "only"` when intent/specification is needed
   (hypothesis, never sole evidence). Doc claim (number, limit, default) →
   SKILL.md "Doc claim in hand" (verification line + both outcome lines).

No `filter:{presets}` by default — understanding needs breadth.

Start discovery with metadata and a small page, then select anchors. Read only
methods required for current claims, not whole classes or trees. Expand an
exhaustive request deliberately; never infer absence from the first page.

Scan results: files, modules, patterns, domain boundaries.

## PICK + EXPLORE

For a result needed to close an evidence gap:

- **"Same thing elsewhere?"** → find_similar (code or chunk ID)
- **"What is this symbol?"** → find_symbol (full definition). 0 results → act on
  `empty.reason` (`unknownSymbol` / `ambiguous` → a `suggestions` id verbatim),
  still nothing → hybrid_search.
- **"Surrounding context"** → `find_symbol` `relativePath` outline → drill
  neighbour id (`navigation.prev/nextSymbolId`); never Read.

Fewer deep dives > many shallow.

## Direct input (no BREADTH)

Treat a supplied snippet as evidence. Use `find_similar` only when matching code
or similarities are requested; otherwise explain the supplied code directly.

## FORMAT

Answer per strategy reference picked in Step 0 (explain / trace / pre-gen /
exemplar pattern).

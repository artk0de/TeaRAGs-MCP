# Search Cascade

## Three-Tool Cascade

Order: **intent → structure → exact match**.

| Axis                | Tool                                                                        | Use for                                                   |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Meaning / intent    | TeaRAGs (`semantic_search`, `hybrid_search`, `find_similar`, `rank_chunks`) | Discovery, pattern finding, signal-based ranking          |
| Structure / shape   | tree-sitter (`analyze_code_structure`, `query_code`)                        | Classes, methods, signatures — without reading full files |
| Exact text / tokens | ripgrep (`search`, `count-matches`)                                         | Call-sites, identifiers, TODOs, config keys               |

## When to Use What

- **Understanding code** → read the file. Don't ripgrep 10 patterns — just read
  the function.
- **Confirming something exists** → ripgrep. One call, specific pattern.
- **Finding where something is used** → ripgrep. Call-sites, imports.
- **Finding code by meaning** → TeaRAGs. Not ripgrep, not file reading.
- **Structural overview** → tree-sitter. Methods, signatures without full read.

## Verification After Semantic Search

Semantic search is a **candidate zone generator**, not proof.

After TeaRAGs call, verify candidates exist:

1. **ripgrep** — ONE call to confirm key identifier exists. 0 matches = discard.
2. If confirmed → **read the function** to understand it. Don't ripgrep 5 more
   patterns.

## PROHIBITED: Built-in Search/Grep

**NEVER use built-in `Search` or `Grep` tools for code discovery.** These tools
bypass the cascade and return raw text without git signals or overlay labels.

Use ONLY:

- **TeaRAGs** (`semantic_search`, `hybrid_search`, `find_similar`,
  `rank_chunks`) — for discovery
- **ripgrep MCP** (`search`, `count-matches`) — for exact text confirmation
- **tree-sitter** — for structural analysis

Built-in Search/Grep exist in the agent runtime but are NOT part of this
workflow. If you catch yourself reaching for them — stop and use the cascade
above.

## Anti-Patterns

| Anti-pattern                                 | Correct approach                        |
| -------------------------------------------- | --------------------------------------- |
| Built-in `Search` or `Grep` for finding code | TeaRAGs or ripgrep MCP — NEVER built-in |
| 10+ ripgrep calls instead of reading a file  | Read the file — it's faster             |
| ripgrep for "how does X work"                | TeaRAGs semantic_search                 |
| TeaRAGs for exact method names               | ONE ripgrep call                        |
| Multiple semantic_search for same area       | One call, then read results             |
| `git log` / `git diff` for code history      | TeaRAGs overlay has git signals         |

## search_code Prohibition

Agents MUST use `semantic_search`, `hybrid_search`, `find_similar`, or
`rank_chunks` — these return structured JSON with overlay labels.

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to
`semantic_search`.

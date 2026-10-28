# Skill choice — which skill or rerank preset answers this task

Index of all routing guides: `tea-rags://guide/decision-tree`. No skill matches
→ guide `tool-choice`.

## Skills

Check FIRST — skills encapsulate the right tool sequence, rerank presets, output
formatting. Take first matching branch.

```
├─ Explore/understand/investigate/research code → /tea-rags:explore — open its
│   SKILL.md, state its Step 0 strategy first. Decisive calls:
│   ├─ pre-change ("before I modify/refactor X", "research X first", plan step
│   │   "Research X before implementing Y", risks of ONE named change) → PRE-GEN:
│   │   semantic_search metaOnly=true limit=10 → ONE find_symbol(symbols=[2–5
│   │   key symbols], rerank="techDebt") → find_symbol on 1–2 base symbols,
│   │   never call chains.
│   │   Self-contained — not brainstorming / executing-plans / DDG / risk-assessment
│   ├─ "what changed recently in X" → rank_chunks rerank="codeReview" maxAgeDays=14
│   └─ "who owns / knows X" → rank_chunks rerank="ownership" (never semantic_search)
├─ Bug hunting ("why does X fail", symptom / failure to blame) → /tea-rags:bug-hunt
├─ Code generation/modification, "add <feature> in our style, no duplicates"
│   → /tea-rags:data-driven-generation
├─ One analytics question one preset / recipe answers ("bug-prone areas in X",
│   "looks stable but breaks", "who drives X lately", "old auth code")
│   → /tea-rags:analytics-rerank (single call, not a scan)
├─ Risk/health of an AREA, most dangerous modules (multi-preset scan, tiers)
│   → /tea-rags:risk-assessment
├─ Layout / dependency direction / SDP, "is the codebase laid out correctly"
│   → /tea-rags:architecture-diagnostics
├─ Plan a refactoring (ordered, simulated fix steps) → /tea-rags:refactoring-planning
├─ What in this MR to look at first → /tea-rags:mr-review
├─ Which tests cover the behaviour I change → /tea-rags:tests-as-context
├─ Review a diff / MR ("what does my change break") → `review_changes(changes:{base})`
│   sections: naming | incompleteChange | cohesion | architecture — default all;
│   unknown = error; absent section = not asked; NOT a search tool, never discovery
├─ Pick rerank preset / custom weights, filter shape → sections below
└─ No skill matches → guide `tool-choice`
```

## Analytics question → call

| Question                                                     | Call                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Onboard me into `<area>` / entry points                      | `/tea-rags:explore` · `semantic_search(rerank: "onboarding" \| "entryPoint", pathPattern)`                       |
| Which modules the app is built around                        | `rank_chunks(rerank: "architecturalHub")` · `filter: { presets: "hubs" }`                                        |
| Which of N similar implementations to copy                   | `semantic_search(query, rerank: "proven", filter: { presets: "battleTested" })`                                  |
| Is there already a helper for `<X>`                          | `find_similar(positiveCode: "<draft>")`                                                                          |
| What not to touch / where to build a parallel implementation | `rank_chunks(rerank: "criticalPath" \| "blastRadius" \| "godModule", pathPattern)`                               |
| What needs a second reviewer                                 | `rank_chunks(rerank: "criticalPath" \| "criticalMethod", filter: { presets: "panicZone" \| "unstableCore" })`    |
| Map the tech debt in `<area>`                                | `rank_chunks(rerank: "techDebt" \| "refactoring" \| "decomposition" \| "godModule" \| "godMethod", pathPattern)` |
| What changed most lately in `<area>`                         | `rank_chunks(rerank: "hotspots", pathPattern, maxAgeDays: <N>)`                                                  |
| What is dead or abandoned                                    | `semantic_search(query: "<area>", filter: { presets: "deadCandidates" \| "abandonedHotspots" })`                 |
| Who owns `<area>`, where is the bus factor one               | `rank_chunks(rerank: "ownership", pathPattern)` · `filter: { presets: "fragileSilo" }`                           |
| Old security-critical code overdue for audit                 | `semantic_search(query, rerank: "securityAudit", filter: { presets: "securityPaths" })`                          |

## Rerank → /tea-rags:analytics-rerank

Picking a preset, building `{custom: {...}}` weights, or applying an analytics
recipe (ownership, tech-debt, hotspots, code-review, security-audit,
fragile-silo) → `/tea-rags:analytics-rerank`. Documentation searches
(`language: "markdown"` OR `documentation: "only"`) auto-apply
`documentationRelevance` — no explicit rerank needed. Interpreting overlay
signals architecturally (god module vs bug attractor, healthy owner vs toxic
silo, legacy minefield vs proven stable) →
`rules/references/signal-interpretation.md`.

## Filters → /tea-rags:filter-building

Field selection, `level: "file" | "chunk"`, pathPattern negation, raw `filter:`
→ `/tea-rags:filter-building`. Typed sugar fields and person scope (`author` /
`recentAuthor` / `contributor`) → guide `overview` "Typed filters"; raw syntax,
payload keys → guide `filters`.

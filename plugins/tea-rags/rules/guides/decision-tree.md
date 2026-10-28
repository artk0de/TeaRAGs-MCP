# Decision Tree — index of routing guides

One guide per question class. Read ONLY the guide whose row matches — never all.

| Question                                                            | Guide                                  |
| ------------------------------------------------------------------- | -------------------------------------- |
| Which tool: definition / usages / intent / structure / naming / A→B | `tea-rags://guide/tool-choice`         |
| Which skill or rerank preset; analytics, risk, ownership, tech debt | `tea-rags://guide/skill-choice`        |
| Research / planning question (implements, registered, DB, ticket)   | `tea-rags://guide/research-questions`  |
| Is this move banned; fallback when the primary tool fails           | `tea-rags://guide/prohibited-patterns` |
| pathPattern shape, raw `filter:` syntax, payload keys               | `tea-rags://guide/filters`             |
| After a search: drill, outline, graph navigation                    | `tea-rags://guide/navigation`          |
| 0 / too many hits, `empty.reason`, ambiguity, stop conditions       | `tea-rags://guide/pagination`          |
| Stale / drifted index, `treeState`, reindex consent                 | `tea-rags://guide/freshness`           |

**Subagents.** Before an `Agent` dispatch prepend the block in
`rules/references/subagent-injection.md` (subagents inherit no rules); never
inject a fixed `path` — the subagent passes its own working directory.

**References** (read when needed): `rules/references/use-cases.md` (use cases by
task), `polyglot-rule.md` (per-language splitting), `axis-splitting.md`
(sources/tests/docs axes), `signal-interpretation.md` (overlay signal pairs),
`runtime-introspection.md` (resource catalog, `infraHealth`, drift,
`rankingOverlay`).

**MCP resources are canonical for presets, signal keys, filter syntax** —
generated from the live registry; read
`ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/<name>")`, never
guess names.

**Portability.** Guides assume Claude Code (`/tea-rags:*` skills, `Agent`,
`ReadMcpResourceTool`). MCP-only clients strip skill directives and read
`tea-rags://guide/search-examples` (routing + examples), `overview`, `presets`,
`filters`, `signals`; the routing guides above apply to any client.

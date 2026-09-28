/**
 * Resource registration module
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { PresetDescriptors } from "../../core/api/public/dto/explore.js";
import { InvalidParameterError, type App, type PayloadSignalDescriptor } from "../../core/api/public/index.js";

/**
 * The metaOnly response contract — stated once, here. Every search tool's
 * `metaOnly` hint points at it (filterMetaOnly / applyEssentialSignals select
 * raw fields; BaseExploreStrategy#applyMetaOnly keeps rankingOverlay).
 */
export const META_ONLY_CONTRACT =
  "Payload stays RAW, same paths + value forms as without metaOnly: flat signals at root, " +
  "git trimmed to essential fields (commitCount, ageDays, taskIds, blame*), codegraph.symbols.* whole — " +
  "never {value,label}. Labels live only in rankingOverlay.{file,chunk}.<field> ({value,label} when " +
  "labelled, else raw), present whenever rerank ran; flat structural signals (methodLines, imports) " +
  "under rankingOverlay.file. Signal outside essential set → read rankingOverlay (if preset surfaces it) " +
  "or metaOnly=false.";

/**
 * Param reference — the prose that used to ride inline on every tool param
 * (bd tea-rags-mcp-ewg2s). Schema keeps a ≤ 20-word hint; the semantics an
 * agent needs to get a call exactly right live here.
 */
function buildParamReference(): string {
  return `## Param reference
Inline param hints short; full semantics here.

### Addressing (every project-aware tool)
- \`project\` [RECOMMENDED] — registry alias; survives path moves, pulls qdrantUrl / embeddingModel from entry.
- \`collection\` — raw Qdrant name. \`path\` — codebase path, auto-resolves.
- Resolution priority: collection > project > path. Give one.

### level (semantic_search, hybrid_search, rank_chunks, find_similar)
- 'chunk' = rank chunks (functions, classes, blocks) — decomposition, hotspots.
- 'file' = rank files as units — tech debt, ownership. Result carries file-level payload only
  (relativePath, language, imports, git.file, codegraph.symbols.file, …): no chunk fields, no content.
  Outline a file via find_symbol(relativePath).
- Unset → preset signalLevel. Explicit value overrides preset.
- Also sets payload scope of level-aware filters. Unset → each filter's own default:
  minAgeDays/maxAgeDays/minCommitCount: chunk; taskId/author/minFanIn/minFanOut: file.
  modifiedAfter/modifiedBefore/recentAuthor/contributor file-level regardless.

### Typed filters
- \`author\` — blame owner (most live lines, git blame HEAD), exact name. level 'chunk' → owner of chunk's own lines.
- \`recentAuthor\` — top committer to FILE in git log window (not blame); name OR email. 'What did X work on' → recentAuthor + modifiedAfter.
- \`contributor\` — any window committer, exact name as git records it. Superset: 'everything X touched' → contributor; 'where X dominates' → recentAuthor.
- \`modifiedAfter\` / \`modifiedBefore\` — git.file.lastModifiedAt vs ISO date ('2024-01-01', '2024-01-01T00:00:00Z').
- \`minAgeDays\` / \`maxAgeDays\` — age from lastModifiedAt at QUERY time (0 = within a day). Chunk level: chunk with no
  commit in chunk git window (and docs) dropped. level 'file' → file last commit, grouped per file.
  File-level recency at chunk granularity → modifiedAfter.
- \`taskId\` — JIRA (TD-1234), GitHub (#567), Azure DevOps (AB#890). File: any commit of file; chunk: chunk's own commits.
- \`symbolId\` — text match: 'Class' → all its methods, 'method' → that method in any class.
- Codegraph filters (\`minFanIn\`, \`minFanOut\`, \`minPageRank\`, \`minInstability\`, \`minTransitiveImpact\`,
  \`minConnectionCount\`, \`isHub\`, \`isLeaf\`) exposed only when codegraph enabled.
  fanIn/fanOut: file = importing / imported files; chunk = call sites / outgoing calls.
- \`documentation\` / \`testFile\`: only | exclude | include. Omitted → no filter of own, but preset default may exclude.

### filter (raw Qdrant or { presets })
- Raw: must/should/must_not — syntax in tea-rags://schema/filters. Named: \`{ presets: "a,b" }\`.
- Omitted → rerank preset's default filter applies (most: production = no tests/docs/block).
  Any explicit filter replaces it; \`{}\` clears it.
- Default skipped automatically when typed params explicitly select what it excludes:
  testFile "only" / "include", documentation "only" / "include", chunkType test/test_setup, language "markdown".
- Default DID apply → response carries presetFilterNotice naming it + how to clear.

### metaOnly
${META_ONLY_CONTRACT}
Default false; rank_chunks default true (analytics — false to include code).

### fields
- Dot-path allow-list applied server-side before serialization — cuts response size.
- Nesting matters: signals under git.{file,chunk}.* and codegraph.symbols.{file,chunk}.* (tea-rags://schema/signals).
- EXACT: nothing added back, relativePath included. Omitted → full payload.
- metaOnly = different axis (drops body, trims git). Path no result carried → fieldsWarning, not failure.

### find_similar
- positiveCode: any code block; each string = one example, embedded on the fly.
- strategy: best_score (default) scores each candidate vs every example, supports negative-only;
  average_vector averages positives, fastest; sum_scores sums across examples.

### find_symbol
- symbol: Class#method (instance), Class.method (static), fn (top-level), Class → class + members.
  symbol XOR relativePath. pathPattern applies to symbol mode only.

### Codegraph tools
- get_callers includeAmbiguous: ambiguous dispatch sites whose member matches target — call MAY reach
  target among candidateCount candidates; not materialized as edges. Default false.
- find_cycles pathPattern: cycle kept if ≥1 member resolves to matching file → cross-boundary cycles retained.
- trace_path fromPath / toPath: top-level symbols share bare ids; omitted → trace from all, candidates as namesakes.

### Indexing / collections
- index_codebase seedFromWorktree: sibling git worktree of same repo, same model + settings → clone its index,
  embed only differing files. First index only.
- create_collection schema: top level \`{ "type": "object", "properties": {...} }\`; add_documents validates each
  document's metadata (all-or-nothing per batch), stores schema \`default\` for absent fields. Omit = free-form.
- create_collection distance: Cosine recommended (all providers); Dot ≡ Cosine on normalized; Euclid rarely for text.
`;
}

export function buildOverview(): string {
  return `# tea-rags Schema Overview

## Available Resources
- tea-rags://schema/presets — rerank presets reference
- tea-rags://schema/signals — custom weight signals reference (canonical
  catalog of weight keys — read BEFORE building a custom rerank)
- tea-rags://schema/filters — Qdrant filter syntax and examples

## Tools Quick Reference
- search_code — quick semantic lookup, human-readable output
- semantic_search — analytical, structured JSON, full metadata
- hybrid_search — semantic + BM25, best for symbol name + context
- rank_chunks — batch analytics by signals (metaOnly default true; offline scoring, not online search)
- find_similar — find code similar to examples; negative-only inputs + strategy="best_score" → anti-pattern detection
- find_symbol — symbol definition by name OR file outline/doc TOC by relativePath (no embedding);
  pass a rerank preset for a single-call diagnostic (definition + rankingOverlay)

## Observability hooks
- get_index_status returns an \`infraHealth\` block: qdrant url/status/optimizer,
  embedding url/reachable, per-trajectory enrichment health. First debug-point
  when search fails or returns unexpected results.
- Every search response can include \`driftWarning\` when the running build has
  moved past what the index was built with — new payload fields, or a newer
  grammar / walker for a language it holds. It names the one command that
  repairs it. Surface it to the user; do NOT auto-trigger a reindex.
- A search that named a rerank preset can come back with \`presetFilterNotice\` — that
  preset's DEFAULT filter (most: production = no tests/docs/block) narrowed the set and
  you never wrote it. It names the preset, the payload keys the default constrains, and
  the param that clears it. Read it before concluding the corpus lacks the code.
- Every reranked result carries \`rankingOverlay\` \`{preset, file, chunk}\` — the preset's
  surfaced signals keyed by bare field name, \`{value,label}\` when labelled, raw otherwise.
  metaOnly results keep it; it is the only place labels live (the metaOnly param states the contract).
  Read tea-rags://schema/signal-labels for the label resolution algorithm.

## Project calibration
get_index_metrics returns per-language × per-scope (source/test) percentile
labelMaps for every signal. Use \`signals[lang][key][scope].labelMap\` to pick
thresholds for filters like minCommitCount / minAgeDays — what counts as "high"
or "legacy" varies by codebase.

## Guides
- tea-rags://schema/search-guide — search tool routing, use cases, examples
- tea-rags://schema/indexing-guide — indexing options, git metadata guide
- tea-rags://schema/signal-labels — human-readable label mappings for numeric signals

${buildParamReference()}
## IMPORTANT: Destructive Tools

**NEVER call these tools without explicit user confirmation:**
- \`clear_index\` — deletes ALL indexed data for a codebase (chunks, git metadata, snapshots)
- \`delete_collection\` — permanently deletes a Qdrant collection and all its data
- \`delete_documents\` — permanently deletes specific documents from a collection

These operations are **irreversible**. Re-indexing a large codebase can take minutes.
Other sessions may depend on the same index — clearing it breaks their search.

**If indexing fails with "Conflict":** another session is already indexing.
Wait for it to finish or restart the MCP server. Do NOT clear the index to work around it.
`;
}

export function buildPresetsDoc(descriptors: PresetDescriptors): string {
  const seen = new Set<string>();
  let md = "# Rerank Presets\n\n";

  for (const [, presets] of Object.entries(descriptors.presetDetails)) {
    if (presets.length === 0) continue;
    for (const p of presets) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      md += `## ${p.name}\n\n`;
      md += `${p.description}\n\n`;
      md += `**Signals:** ${p.weights.join(", ")}\n\n`;
      md += `**Tools:** ${p.tools.join(", ")}\n\n`;
    }
  }
  return md;
}

export function buildSignalsDoc(descriptors: PresetDescriptors): string {
  let md = "# Custom Weight Signals\n\n";
  md += "All signals accept a number (weight). Available for `{custom: {...}}` rerank mode.\n\n";
  for (const sig of descriptors.signalDescriptors) {
    md += `- **${sig.name}**: ${sig.description}\n`;
  }
  return md;
}

export function buildSearchGuide(): string {
  return `# Search Guide — Parameter Examples

Tool routing is in the search-cascade rule. This resource has concrete
parameter examples per tool.

## search_code Examples

- "Complex code not touched in 30+ days" → query="complex logic", modifiedBefore="<ISO date 30 days ago>"
- "What did John work on last week?" → recentAuthor="<full name or email>", modifiedAfter="<ISO date 7 days ago>"
- "Everything John touched (even files he doesn't dominate)" → contributor="<exact git name>"
- "Payments code Alice owns" → query="payments", author="<exact blame name, e.g. Alice Smith>"
- "High-churn authentication code" → query="authentication", minCommitCount=5
- "Code related to ticket TD-1234" → taskId="TD-1234"

## semantic_search Examples

- Ownership analysis → rerank="ownership", metaOnly=true
- Tech debt discovery → rerank="techDebt", level="file", minAgeDays=90
- Security audit → rerank="securityAudit", pathPattern="**/auth/**"

## hybrid_search Examples

- Symbol + context → query="PaymentService validate card expiration"
- Class definition → query="def automations_disabled_reasons"
- Note: BM25 component currently degraded — see search-cascade Known Limitations

## find_symbol Examples

**By symbol name (symbol param):**
- Instance method → symbol="Reranker#rerank" (# = instance)
- Static method → symbol="Reranker.create" (. = static)
- Class outline → symbol="Reranker" (outline: member symbolIds, NO bodies, tests excluded)
- Drill from outline/TOC → symbol="<id copied from an outline line>" (one member / doc section)
- Existence check → symbol="myFunc", metaOnly=true (no content)
- With signals → symbol="Reranker#score", rerank="hotspots" (ranking overlay)

**By file path (relativePath param, mutually exclusive with symbol):**
- File outline → relativePath="src/reranker.ts" (code structure with hierarchy)
- Doc TOC → relativePath="docs/api.md" (heading TOC with doc:<hash> references)
- From search result → find_symbol(symbol: parentSymbolId) → class outline or doc TOC (doc parent = doc path)

## rank_chunks Examples (batch analytics, not online search)

rank_chunks scrolls and ranks ALL chunks by the chosen rerank — metaOnly is
true by default. Use for offline scoring across a domain, NOT query-driven
search.

- Decomposition candidates → rerank="refactoring"
- Hotspot detection → rerank="hotspots"
- Ownership reports → rerank="ownership", metaOnly=true
- Domain scoping → pair any of the above with pathPattern="**/payments/**"

## find_similar Examples

- Find similar to a snippet → positiveCode="<paste>"
- Find similar to previous results → positiveIds=[<chunk ids>]
- Anti-pattern detection → negativeCode="<the anti-pattern>", strategy="best_score"
  (no positives — returns code maximally UNLIKE the negative; outlier / novelty
  / refactor-candidate detection)

## get_naming_lexicon Examples

Codegraph on only. Judges names against project's own vocabulary; never judge a
name by grep or semantic_search on the draft. Evidence read within draft's language
namespace (languages sharing a naming convention's typeNamespace, e.g. TS + JS);
never another language's rows. Ruby: \`@@x\`, \`x ||= v\`, and accessor macros
(attr_*, cattr_*/mattr_*, catalogue accessors — one field per operand) all
declare \`kind: "field"\` rows, same as \`@ivar =\`.

- "What does the project call values of type T?" → types=["TaxAutomationDocument"], language="ruby"
- "Is Helper or Concern this area's suffix?" → types=["Helper","Concern"], pathPattern="app/lib/**" —
  a one-word type also answers typeNameHeads { scope, heads[{ head, n, files, kinds, examples }] }:
  the declarations under the pattern whose names END in it (namespace modules excluded)
- "Is this name right?" (one draft / rename) → names=[{ name: "row", kind: "local", type: "TaxAutomationDocument" }]
- An EXISTING name → add path: "<its file>" (any kind): that file is left out of the evidence, as a
  review leaves out changed files — a declaration never counts, collides with or confirms itself.
- New class / constant → names=[{ name: "RubyConstReceiverPass", kind: "type", path: "<its file>", extends: "SymbolResolutionStrategy" }]
- Words for a concept → concept="<what the symbol denotes, not its name>", language="typescript"
- Review names a diff adds → changes={} (uncommitted vs HEAD) or changes={ base: "origin/main" } (branch).
  base is read at its merge-base with HEAD (git merge-base <base> HEAD): only the branch's side plus
  uncommitted work, however far base moved on; no merge-base (unrelated / shallow clone) → error.
  files=[...] → those files only: a file with a diff by its added hunks, one with no diff (committed,
  clean tree) WHOLE — every declaration it holds, counted in wholeFiles.
  Only added hunks judged; changed files excluded from evidence; cap 200 files (truncated reports rest).
  project alone → MAIN checkout's tree. Change in a git worktree → project + path="<abs worktree path>"
  (same repo, else error): project = index, path = tree; diff read there, judged vs project index
  (collection + path already split so). Empty diff (no files) → notice naming committed-work
  (changes.base) and worktree (path) exits + repo's other trees — never trust changedFiles: 0 alone.
  Answer → review { workTree, base, mergeBase, changedFiles, wholeFiles?, checked, conforming, novel, findings, notes?,
  notJudged, notJudgedBy?, notJudgedNames?, truncated? }; changedFiles = files differing from mergeBase
  (with files: of the listed); notJudgedBy = kind (file) → reason → count — only files go unjudged;
  a method with no known return type is never skipped — it is an untyped return draft, judged by
  the project's method vocabulary: its noun tail's dominant project verb → MISFIT (verb-swapped
  suggestion), even when the draft's own head sits outside the verb lexicon, unless that head is
  itself a project noun (ends more names than it starts); a verb the project already uses for the
  tail → CONFORMS; verbless → CONFORMS when declared elsewhere in scope, else NO_CONVENTION
  (analogues); notJudgedNames = first 50 { relPath, line?, name?, kind, reason } — read them yourself;
  findings flat { relPath, line, name, kind, type?, verdict, … } — non-CONFORMS verdicts and
  CONFORMS with alternatives. notes = CONFORMS on a generic name (genericName; information, counted
  in conforming). novel = NO_CONVENTION, or NEW_TERM with nothing to compare (not listed). notJudged = files
  skipped: tests / non-production, no codegraph language.
  Type / constant names need a codegraph recompute on an index built before type declarations existed.
- indexLag { indexedCommit, treeCommit } on any answer = index built at another commit than the tree's
  HEAD (review.workTree tree): every verdict rests on evidence at indexedCommit; later changes unseen.

Verdicts: CONFORMS (vocabulary, not behaviour; may carry alternatives) | MISFIT (suggestion,
role) | NEW_TERM (topTerms, alternatives — soft,
never a rename demand) | NO_CONVENTION (prefer { exact?, analogous }) | COLLISION (existing).
NO_CONVENTION = value (param / local / field) whose type or call has no name ≥ 2 owners share: no
demand, not free either — name it prefer.exact (type spelled, plural for many) or like
prefer.analogous (own thin rows, then family values: types specializing it — CallerSymbolId for
SymbolId — else siblings by head word); a name unlike both needs a reason. CONFORMS rests on evidence: a type's carries the
role or project suffix it rests on (role); an untyped value nothing compares conforms only when other rows
use the name (evidence.n), else NO_CONVENTION. A MISFIT (value or return) needs ≥ 2 owners
(distinct holders, not rows) behind its suggestion, never deletes the draft's qualifier or complement
(for_payload), never suggests a connector-led row (for_delivery), and a local named after its own
type conforms unless the type's values are never named that way; a collection named by its
element type's plural (tax_preparations) conforms over a container noun (scope). topTerms offer
only names ≥ 2 owners share. A return's leading accessor verb (build_, read_, fetch_…) belongs to
the method: its noun is judged (build_api_client → api_client). An untyped value read off a
constant receiver (UploadTargetBuffer.read) is offered the receiver's concept (upload_target). A
return whose owner's in-project ancestor declares the method (diff mode: enclosing class; names
mode: the class at path) is an override: CONFORMS with override.declaredBy, and
evidence.collisions (up to 3 ids) lists the ancestors' declarations first. Role = inheritance family > directory > project
suffix; project suffix only confirms, never MISFIT. The nearest family decides: the subclasses
of extends as written (A::Workflow::Worker), else of every supertype sharing its last segment. The
written family's role may be a tail (role.tail AsyncWorkflow, role.word its head workflow): the
suffix every distinct name carrying the head shares, each word named by that supertype. A draft conforms only
ending in the whole tail; ExportWorkflow → ExportAsyncWorkflow, ExportJob → ExportJobAsyncWorkflow. A directory role is read
off each file's PRIMARY type and holds only a draft that would be its file's primary — a helper interface /
class beside IndexingOps is no *Ops member (diff mode knows the file; names mode: indexed declarations at path). A directory-evidence MISFIT is
location-based: rename only when the type belongs to role.examples' family. CONFORMS with
role.carriedInName=false: the kind a family of action-named types takes from its supertype
and directory (KindOfService under app/services → service) — what the type IS, never a
word the name owes.

## get_ontology_report Examples

- Project-wide naming audit → sections=["synonyms","homonyms","outliers","collisions"], pathPattern="src/**"
- Method-naming audit (opt-in) → sections=["verbs"]: per noun tail, the verbs the project uses plus
  the deviants D4 would call MISFIT — contested tails only.

## Pagination

Every search tool accepts offset for cursor-style pagination. Page exhausted but
need more → retry with offset=N instead of inflating limit. Don't paginate past
the point where results stop matching the intent — reformulate the query instead.

## Single-call diagnostic recipes

- Class with risk overlay →
  find_symbol(symbol: "PaymentService", rerank: "hotspots")
  Returns class outline (member ids, no bodies) PLUS rankingOverlay with churn/ownership/bugFixRate;
  drill a member with find_symbol(symbol: "PaymentService#charge").
- Method with risk overlay →
  find_symbol(symbol: "PaymentService#charge", rerank: "hotspots")
- File-scoped outline → find_symbol(relativePath: "src/payments/service.ts")
- Doc-TOC mode → find_symbol(relativePath: "docs/api.md") returns heading
  list with doc:<hash> ids; second find_symbol(symbol: "doc:<hash>") returns
  that section. Works on any markdown corpus, not just code.
`;
}

export function buildIndexingGuide(): string {
  return `# Indexing Guide

## index_codebase Options

- \`path\` — root directory to index
- \`forceReindex\` — rebuild the whole index into a new collection (zero downtime, alias swaps at the end)
- Scoped force: \`forceReindex\` plus any of \`languages\`, \`testFile\` (only | exclude),
  \`pathPattern\`, \`fileExtension\`, \`files\` re-chunks and re-embeds ONLY the selected
  indexed files, in place on the live collection; every other point is untouched. The
  filters combine as AND and match like their search namesakes. Needs an existing index.
  A drift report whose chunking bump declared a scope names this form in its \`Run:\` line.
- \`extensions\` — file extensions to include (default: auto-detect)
- \`ignorePatterns\` — additional ignore patterns beyond .gitignore

## Git Metadata

Set \`CODE_ENABLE_GIT_METADATA=true\` before indexing.

Enables filters:
- author — blame-dominant author (owner of most live lines, git blame HEAD); file-level default, level "chunk" → chunk's own lines. The live-line-owner filter — there is no separate blameOwner param
- recentAuthor — filter by recent-activity dominant author (commit-count based, log window)
- contributor — filter to files the person committed to in the log window (any recent-window committer; superset of recentAuthor)
- modifiedAfter/modifiedBefore — date range (ISO 8601 format)
- minAgeDays/maxAgeDays — code age
- minCommitCount — churn frequency
- taskId — extracted from commit messages (JIRA, GitHub issues)

Git enrichment runs in background after indexing. Check \`get_index_status\` for enrichment progress.

## Index Workflow

1. \`index_codebase\` — full initial index; on re-run auto-detects changed files and does an incremental update (no separate reindex tool)
2. \`get_index_status\` — check status and enrichment progress
3. \`clear_index\` — delete all indexed data (irreversible)
`;
}

/**
 * Git payload keys the filters resource names that the trajectory WRITES to the
 * payload but does NOT declare as payload signal descriptors — verified at the
 * writer (`domains/trajectory/git/infra/metrics/file-assembler.ts`). Since
 * bd tea-rags-mcp-9ot33 declared `git.{file,chunk}.lastModifiedAt` as payload
 * signal descriptors (their percentiles feed the now-relative age floor and
 * label bands), `git.file.firstCreatedAt` is the only remaining
 * written-but-undeclared key; it is read back by the git stats accumulators.
 * The git field enumeration in buildFiltersDoc is GENERATED from the
 * descriptors, so a key appears there either because a descriptor declares it
 * or because it is listed here explicitly. Anything else is a stale name (the
 * schema-v13 contributorCount/authors drift) and the key-existence test in
 * tests/mcp/resources/resources.test.ts fails on it.
 */
export const FILTERS_DOC_WRITTEN_BUT_UNDECLARED_KEYS = ["git.file.firstCreatedAt"] as const;

/** Render the field enumeration line for one git payload level from the descriptors. */
function gitFilterFields(payloadSignals: PayloadSignalDescriptor[], prefix: string): string {
  const field = (key: string) => {
    const name = key.slice(prefix.length);
    const isArray = payloadSignals.find((s) => s.key === key)?.type === "string[]";
    return isArray ? `${name}[]` : name;
  };
  const declared = payloadSignals.filter((s) => s.key.startsWith(prefix)).map((s) => field(s.key));
  const undeclared = FILTERS_DOC_WRITTEN_BUT_UNDECLARED_KEYS.filter((key) => key.startsWith(prefix)).map(field);
  return [...declared, ...undeclared].join(", ");
}

export function buildFiltersDoc(payloadSignals: PayloadSignalDescriptor[]): string {
  let md = "# Qdrant Filter Syntax\n\n";
  md += "## Operators\n\n";
  md += '- `match: {value: "exact"}` — exact string/number match\n';
  md += '- `match: {text: "partial"}` — partial text match\n';
  md += '- `match: {any: ["a", "b"]}` — match any value in array\n';
  md += "- `range: {gte: 5, lte: 10}` — numeric range\n\n";
  md += "## Combining conditions\n\n";
  md += "- `must: [...]` — AND (all conditions must match)\n";
  md += "- `should: [...]` — OR (at least one must match)\n";
  md += "- `must_not: [...]` — NOT (none must match)\n\n";
  md += "## Available fields\n\n";
  md += "**Chunk metadata:** relativePath, fileExtension, language, startLine, endLine, ";
  md += "chunkIndex, isDocumentation, name, chunkType, parentSymbolId ";
  md += "(class name for code, relative path for docs), parentType, symbolId, navigation, headingPath\n\n";
  md += "**Git metadata** (requires enrichment, two levels):\n\n";
  // Field lists GENERATED from the payload signal descriptors (single source of
  // truth) — do not hand-edit; a renamed descriptor key updates this doc through
  // the registry (bd tea-rags-mcp-yd6zp).
  md += `File-level (\`git.file.*\`): ${gitFilterFields(payloadSignals, "git.file.")}\n\n`;
  md += `Chunk-level (\`git.chunk.*\`): ${gitFilterFields(payloadSignals, "git.chunk.")}\n\n`;
  md += "**Ownership semantics:** `recentDominantAuthor*` = recent commit activity within the ";
  md += "log window (TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS); `blameDominantAuthor*` = who owns ";
  md += "the live lines in HEAD via git blame. Use the latter for true ownership / silo detection.\n\n";
  md += "**⚠ Filter level:** `level` does two things. (1) Scope of level-aware typed filters: ";
  md += "effective level (explicit `level`, else rerank preset `signalLevel`) re-scopes all of them; ";
  md += "unset → each filter's default: `minAgeDays` / `maxAgeDays` / `minCommitCount` → `git.chunk.*`, ";
  md += "`taskId` / `author` → `git.file.*`, codegraph `minFanIn` / `minFanOut` → file. `modifiedAfter` / ";
  md += "`modifiedBefore` always read `git.file.lastModifiedAt`, `recentAuthor` always ";
  md += "`git.file.recentDominantAuthor*`, `contributor` always `git.file.recentAuthors`, any ";
  md += "`level`. (2) Result granularity: ";
  md += '`level: "file"` → one result per file, file-level payload only (no chunk fields, no content; ';
  md += "outline via `find_symbol(relativePath)`). `minAgeDays` / `maxAgeDays` ";
  md += "compare `git.<level>.lastModifiedAt` with query-time now (no drift); chunk timestamp 0 / absent ";
  md += "on chunks with no commit in chunk churn walk (all doc chunks) → chunk age filters drop them. ";
  md += "Age reads are query-time: overlay `ageDays`, `age`/`recency` rerank and the ageDays filter ";
  md += "presets derive from `git.<level>.lastModifiedAt`, never the stamp. Payload `ageDays` stays an ";
  md += "enrichment-time stamp (`0` = < 1 day then, not no-data) — only a RAW `ageDays` range inherits ";
  md += "that lag.\n\n";
  md += "**Imports:** imports[] — file-level imports\n\n";
  md += "**Codegraph metadata** (requires codegraph indexing — typed filter params, not raw Qdrant keys):\n\n";
  md += "File-level (default level): `minFanIn`, `minFanOut`, `minInstability`, `minTransitiveImpact`, ";
  md += "`minConnectionCount`, `isHub` (boolean), `isLeaf` (boolean)\n\n";
  md += 'Chunk-level (pass `level: "chunk"` to enable for fanIn/fanOut): `minFanIn`, `minFanOut`, `minPageRank`\n\n';
  md +=
    "Note: codegraph payload stored under nested paths (`codegraph.symbols.{file,chunk}.codegraph.{file,chunk}.X`) ";
  md += "to avoid colliding with similarly-named file-level signals. Raw Qdrant filter keys won't resolve — ";
  md += "use the typed filter params above.\n\n";
  md += "## Filter Thresholds\n\n";
  md += "Thresholds vary by codebase. Use `get_index_metrics` for actual percentile-based ";
  md += "label boundaries for your indexed collection. Signals scoped by `source` and `test`:\n";
  md += "```\n";
  md += 'signals["typescript"]["git.file.commitCount"]["source"].labelMap\n';
  md += "→ { low: 1, typical: 3, high: 8, extreme: 20 }\n";
  md += "```\n";
  md += 'means 8 commits = "high" for source code in that codebase. Test code has separate thresholds.\n\n';
  md += "See `tea-rags://schema/signal-labels` for all label mappings.\n\n";
  md += "## Named filter presets (`{presets}` shorthand)\n\n";
  md += "The `filter` param accepts EITHER a raw Qdrant filter object OR a named-presets reference ";
  md += '`{ presets: "name" }` / `{ presets: "a,b,c" }` (CSV, AND-merged) — they are mutually exclusive ';
  md += "in one object. Named presets are curated adaptive filter bundles whose thresholds resolve from ";
  md += "collection percentiles at query time (with cold-start fallbacks), so they scale per repository. ";
  md += "A `{presets}` filter AND-composes with typed params (minAgeDays, language, …).\n\n";
  md += "Catalog (gated by registered trajectories):\n\n";
  md += "- **always available:** `production` (exclude tests/docs/block), `coreLogic` (function/class, no tests), ";
  md += "`securityPaths` (auth/crypto/secret/token/… paths)\n";
  md += "- **require git:** `freshLegacyEdits`, `fragileSilo`, `panicZone`, `godMethods`, `battleTested`, ";
  md += "`abandonedHotspots`\n";
  md += "- **require codegraph:** `hubs`, `deadCandidates`, `unstableCore`\n\n";
  md += "**Inventory vs query rule:** hard specific presets (panicZone, abandonedHotspots, …) suit ";
  md += "query-absent inventory scans where an empty result is a valid answer; query-driven triage should ";
  md += "rank broadly (no hard specific filter) to preserve recall. Hygiene presets (production/coreLogic) ";
  md += "are safe in any mode and are the rerank-preset defaults (when that default applies: see the ";
  md += "`filter` param description).\n";
  return md;
}

export function buildSignalLabelsGuide(payloadSignals: PayloadSignalDescriptor[]): string {
  // Filter to signals with stats.labels
  const withLabels = payloadSignals.filter((s) => s.stats?.labels && Object.keys(s.stats.labels).length > 0);

  // Group by domain prefix
  const groups = new Map<string, PayloadSignalDescriptor[]>();
  for (const signal of withLabels) {
    const prefix = getDomainGroup(signal.key);
    let group = groups.get(prefix);
    if (!group) {
      group = [];
      groups.set(prefix, group);
    }
    group.push(signal);
  }

  let md = `# Signal Labels

Signal labels give human-readable interpretation of numeric signal values
relative to the current codebase distribution. Computed from percentile
thresholds via \`get_index_metrics\`, attached to ranking overlay results
automatically.

## How Labels Work

Each numeric signal declares percentile-to-label mappings. Search result with a
ranking overlay → numeric values enriched with labels:

\`\`\`json
{ "commitCount": { "value": 12, "label": "high" } }
\`\`\`

Label determined by which percentile bucket the value falls into.
Use \`get_index_metrics\` for actual threshold values for your codebase.

## Scoped Thresholds

Signal stats are split into **source** (production code) and **test** scopes.
Test code often has different churn/size patterns — separate thresholds prevent
test noise from distorting production labels.

\`get_index_metrics\` returns:
\`\`\`
signals[language][signal][scope].labelMap
\`\`\`

Example: \`signals["ruby"]["git.file.commitCount"]["source"].labelMap\`
→ \`{ low: 2, typical: 5, high: 10, extreme: 25 }\`

Language with test chunks indexed → a \`"test"\` scope appears with separate
thresholds. Reranker automatically uses the correct scope for label resolution.

`;

  // Render each group as a section with a Markdown table
  for (const [groupName, signals] of groups) {
    md += `## ${groupName}\n\n`;
    md += "| Signal | Labels (percentile → name) |\n";
    md += "|--------|---------------------------|\n";
    for (const signal of signals) {
      /* v8 ignore start -- stats.labels guaranteed by withLabels filter */
      const labels = signal.stats?.labels ?? {};
      /* v8 ignore stop */
      const entries = Object.entries(labels)
        .sort((a, b) => parsePercentile(a[0]) - parsePercentile(b[0]))
        .map(([p, name]) => `${p}: ${name}`)
        .join(", ");
      md += `| \`${signal.key}\` | ${entries} |\n`;
    }
    md += "\n";
  }

  md += `## Label Resolution Algorithm

1. Thresholds walked in ascending percentile order
2. Each label covers [its threshold, next threshold)
3. First label covers everything below its threshold
4. Last label covers everything at or above its threshold

Example: commitCount with thresholds p25=2, p50=5, p75=12, p95=30
- value 1 → "low" (below p25)
- value 8 → "typical" (between p50 and p75)
- value 35 → "extreme" (above p95)
`;

  return md;
}

/** Map a signal key to a human-readable group name. */
function getDomainGroup(key: string): string {
  if (key.startsWith("git.file.")) return "Git File Signals";
  if (key.startsWith("git.chunk.")) return "Git Chunk Signals";
  return "Static Signals";
}

/** Parse percentile number from "pNN" key. */
function parsePercentile(key: string): number {
  return parseInt(key.replace("p", ""), 10) || 0;
}

/**
 * Register all MCP resources on the server
 */
/* v8 ignore start */
export function registerAllResources(server: McpServer, app: App): void {
  // Static resource: list all collections
  server.registerResource(
    "collections",
    "qdrant://collections",
    {
      title: "All Collections",
      description: "List of all vector collections in Qdrant",
      mimeType: "application/json",
    },
    async (uri) => {
      const collections = await app.listCollections();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(collections, null, 2),
          },
        ],
      };
    },
  );

  // Dynamic resource: individual collection info
  server.registerResource(
    "collection-info",
    new ResourceTemplate("qdrant://collection/{name}", {
      list: async () => {
        const collections = await app.listCollections();
        return {
          resources: collections.map((name) => ({
            uri: `qdrant://collection/${name}`,
            name: `Collection: ${name}`,
            description: `Details and statistics for collection "${name}"`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Collection Details",
      description: "Detailed information about a specific collection",
      mimeType: "application/json",
    },
    async (uri, params) => {
      const { name } = params;
      if (typeof name !== "string" || !name) {
        throw new InvalidParameterError("name", "collection name must be a non-empty string");
      }
      const info = await app.getCollectionInfo(name);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );

  // Static resource: schema overview
  server.registerResource(
    "schema-overview",
    "tea-rags://schema/overview",
    {
      title: "Schema Overview",
      description: "Resource catalog, tools quick reference, full param reference for tea-rags MCP",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildOverview() }],
    }),
  );

  // Static resource: rerank presets
  server.registerResource(
    "schema-presets",
    "tea-rags://schema/presets",
    {
      title: "Rerank Presets",
      description: "Detailed reference for rerank presets: descriptions, signals, available tools",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const descriptors = app.getSchemaDescriptors();
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildPresetsDoc(descriptors) }],
      };
    },
  );

  // Static resource: custom signals
  server.registerResource(
    "schema-signals",
    "tea-rags://schema/signals",
    {
      title: "Custom Signals",
      description: "All available weight signals for custom rerank mode with descriptions",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const descriptors = app.getSchemaDescriptors();
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildSignalsDoc(descriptors) }],
      };
    },
  );

  // Static resource: filter syntax
  server.registerResource(
    "schema-filters",
    "tea-rags://schema/filters",
    {
      title: "Filter Syntax",
      description: "Qdrant filter operators, combining conditions, available fields, and threshold guidance",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: buildFiltersDoc(app.getSchemaDescriptors().payloadSignals),
        },
      ],
    }),
  );

  // Static resource: search guide
  server.registerResource(
    "schema-search-guide",
    "tea-rags://schema/search-guide",
    {
      title: "Search Guide",
      description: "Tool routing, use cases, and examples for all search tools",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildSearchGuide() }],
    }),
  );

  // Static resource: indexing guide
  server.registerResource(
    "schema-indexing-guide",
    "tea-rags://schema/indexing-guide",
    {
      title: "Indexing Guide",
      description: "Indexing options, git metadata guide, and reindex workflow",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildIndexingGuide() }],
    }),
  );

  // Static resource: signal labels
  server.registerResource(
    "schema-signal-labels",
    "tea-rags://schema/signal-labels",
    {
      title: "Signal Labels",
      description: "Human-readable label mappings for all numeric signals in ranking overlays",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: buildSignalLabelsGuide(app.getSchemaDescriptors().payloadSignals),
        },
      ],
    }),
  );
}
/* v8 ignore stop */

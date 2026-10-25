# Search Guide — Parameter Examples

Routing: tea-rags://guide/core + tea-rags://guide/decision-tree. Here: concrete param
examples per tool.

## search_code Examples

- "Complex code untouched 30+ days" → query="complex logic", modifiedBefore="<ISO, 30d ago>"
- "What did X work on?" → recentAuthor="<name|email>", modifiedAfter="<ISO>"
- "Everything X touched (even undominated files)" → contributor="<exact git name>"
- "Payments code Alice owns" → query="payments", author="<exact blame name>"
- "High-churn authentication code" → query="authentication", minCommitCount=5
- "Code related to ticket TD-1234" → taskId="TD-1234"

## semantic_search Examples

- Ownership analysis → rerank="ownership", metaOnly=true
- Tech debt discovery → rerank="techDebt", level="file", minAgeDays=90
- Security audit → rerank="securityAudit", `pathPattern="**/auth/**"`

## hybrid_search Examples

- Symbol + context → query="PaymentService validate card expiration"
- Class definition → query="def automations_disabled_reasons"
- Note: BM25 component currently degraded — see tea-rags://guide/degraded

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

rank_chunks scrolls + ranks ALL chunks by chosen rerank; metaOnly default true.
Offline scoring across a domain, NOT query-driven search.

- Decomposition candidates → rerank="refactoring"
- Hotspot detection → rerank="hotspots"
- Ownership reports → rerank="ownership", metaOnly=true
- Domain scoping → pair any of the above with `pathPattern="**/payments/**"`

## find_similar Examples

- Find similar to a snippet → positiveCode="<paste>"
- Find similar to previous results → positiveIds=[<chunk ids>]
- Anti-pattern detection → negativeCode="<the anti-pattern>", strategy="best_score"
  (no positives — returns code maximally UNLIKE the negative; outlier / novelty
  / refactor-candidate detection)

## get_naming_lexicon Examples

Codegraph on only. Judges names against project's own vocabulary; never judge a
name by grep or `semantic_search` on the draft. Evidence read within draft's language
namespace (languages sharing a naming convention's typeNamespace, e.g. TS + JS);
never another language's rows. Ruby: `@@x`, `x ||= v`, and accessor macros
(`attr_*`, `cattr_*`/`mattr_*`, catalogue accessors — one field per operand) all
declare `kind: "field"` rows, same as `@ivar =`.

- "What does the project call values of type T?" → types=["LedgerEntry"], language="ruby"
- "Is Helper or Concern this area's suffix?" → types=["Helper","Concern"], `pathPattern="app/lib/**"` —
  a one-word type also answers typeNameHeads { scope, heads[{ head, n, files, kinds, examples }] }:
  the declarations under the pattern whose names END in it (namespace modules excluded)
- "Is this name right?" (one draft / rename) → names=[{ name: "rec", kind: "local", type: "LedgerEntry" }]
- An EXISTING name → add path: "<its file>" (any kind): that file is left out of the evidence, as a
  review leaves out changed files — a declaration never counts, collides with or confirms itself.
- New class / constant → names=[{ name: "RubyConstReceiverPass", kind: "type", path: "<its file>", extends: "SymbolResolutionStrategy" }]
- Words for a concept → concept="<what the symbol denotes, not its name>", language="typescript"
- Review names a diff adds → `review_changes` (changes={} = uncommitted vs HEAD, changes={ base: "origin/main" } =
  branch, sections: ["naming"]) — the same lexicon pipeline; `get_naming_lexicon` itself takes no diff.
  base is read at its merge-base with HEAD (git merge-base <base> HEAD): only the branch's side plus
  uncommitted work, however far base moved on; no merge-base (unrelated / shallow clone) → error.
  files=[...] → those files only: a file with a diff by its added hunks, one with no diff (committed,
  clean tree) WHOLE — every declaration it holds, counted in wholeFiles.
  Only added hunks judged; changed files excluded from evidence; every changed file read (no cap).
  project alone → MAIN checkout's tree. Change in a git worktree → project + path="<abs worktree path>"
  (same repo, else error): project = index, path = tree; diff read there, judged vs project index
  (collection + path already split so). Empty diff (no files) → notice naming committed-work
  (changes.base) and worktree (path) exits + repo's other trees — never trust changedFiles: 0 alone.
  Answer → review { workTree, base, mergeBase, changedFiles, wholeFiles?, checked, conforming, novel, findings, notes?,
  notJudged, notJudgedBy?, notJudgedNames? }; changedFiles = files differing from mergeBase
  (with files: of the listed); notJudgedBy = kind (file) → reason → count — only files go unjudged;
  a method with no known return type is never skipped — it is an untyped return draft, judged by
  the project's method vocabulary: a lexicon verb the project uses → CONFORMS, a rare one →
  `NEW_TERM` (topTerms), never a MISFIT toward another verb of its noun (`find_user` and `build_user` are
  distinct operations, not synonyms); verbless → CONFORMS when declared elsewhere in scope, else
  `NO_CONVENTION` (analogues). A name a macro composed (`has_one` :account → `build_account`,
  account=) is not spelled on its declaration line: no draft, not counted; notJudgedNames = first 50 { relPath, line?, name?, kind, reason } — read them yourself;
  findings flat { relPath, line, name, kind, type?, verdict, … } — non-CONFORMS verdicts and
  CONFORMS with alternatives or borderline. notes = CONFORMS on a generic name (genericName; information, counted
  in conforming). novel = `NO_CONVENTION`, or `NEW_TERM` with nothing to compare (not listed); a type `NEW_TERM` with borderline is listed. notJudged = files
  skipped: tests / non-production, no codegraph language.
  Type / constant names need a codegraph recompute on an index built before type declarations existed.
- indexLag { indexedCommit, treeCommit } on any answer = index built at another commit than the tree's
  HEAD (review.workTree tree): every verdict rests on evidence at indexedCommit; later changes unseen.

Verdicts: CONFORMS (vocabulary, not behaviour; may carry alternatives) | MISFIT (suggestion,
role) | `NEW_TERM` (topTerms, alternatives — soft,
never a rename demand) | `NO_CONVENTION` (prefer { exact?, analogous }) | COLLISION (existing).
borderline (a type's CONFORMS / `NEW_TERM`) = alternatives within embedding jitter of the similarity
floor: not offered, the verdict is the same every run — whether one fits is your call.
`NO_CONVENTION` = value (param / local / field) whose type or call has no name ≥ 2 owners share: no
demand, not free either — name it prefer.exact (type spelled, plural for many) or like
prefer.analogous (own thin rows, then family values: types specializing it — CallerSymbolId for
SymbolId — else siblings by head word); a name unlike both needs a reason. CONFORMS rests on evidence: a type's carries the
role or project suffix it rests on (role); an untyped value nothing compares conforms only when other rows
use the name (evidence.n), else `NO_CONVENTION`. A MISFIT (value or return) needs ≥ 2 owners
(distinct holders, not rows) behind its suggestion, never deletes the draft's qualifier or complement
(`for_payload`), never suggests a connector-led row (`for_delivery`), and a local named after its own
type conforms unless the type's values are never named that way; a collection named by its
element type's plural (`tax_preparations`) conforms over a container noun (scope). topTerms offer
only names ≥ 2 owners share. A return's leading accessor verb (`build_`, `read_`, `fetch_`…) belongs to
the method: its noun is judged (`build_api_client` → `api_client`). An untyped value read off a
constant receiver (UploadTargetBuffer.read) is offered the receiver's concept (`upload_target`). A
return whose owner's in-project ancestor declares the method (diff mode: enclosing class; names
mode: the class at path) is an override: CONFORMS with override.declaredBy, and
evidence.collisions (up to 3 ids) lists the ancestors' declarations first. Role = inheritance family > directory > project
suffix; project suffix only confirms, never MISFIT. The nearest family decides: the subclasses
of extends as written (A::Workflow::Worker), else of every supertype sharing its last segment. The
written family's role may be a tail (role.tail AsyncWorkflow, role.word its head workflow): the
suffix every distinct name carrying the head shares, each word named by that supertype. A draft conforms only
ending in the whole tail; ExportWorkflow → ExportAsyncWorkflow, ExportJob → ExportJobAsyncWorkflow. A directory role is read
off each file's PRIMARY type and holds only a draft that would be its file's primary — a helper interface /
class beside IndexingOps is no `*Ops` member (diff mode knows the file; names mode: indexed declarations at path). A directory-evidence MISFIT is
location-based: rename only when the type belongs to role.examples' family. CONFORMS with
role.carriedInName=false: the kind a family of action-named types takes from its supertype
and directory (KindOfService under app/services → service) — what the type IS, never a
word the name owes.

## get_ontology_report Examples

- Project-wide naming audit → sections=["synonyms","homonyms","outliers","collisions"], `pathPattern="src/**"`
- Method-naming audit (opt-in) → sections=["verbs"]: per noun tail, the verbs the project uses,
  with holders — descriptive, contested tails only; no verb is a deviant of another.

## Pagination

Every search tool takes offset. Page exhausted, need more → offset=N, never
inflate limit. Results stop matching intent → reformulate, don't paginate.

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

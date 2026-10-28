# Qdrant Filter Syntax

## Operators

- `match: {value: "exact"}` — exact string/number match
- `match: {text: "partial"}` — partial text match
- `match: {any: ["a", "b"]}` — match any value in array
- `range: {gte: 5, lte: 10}` — numeric range

## Combining conditions

- `must: [...]` — AND (all conditions must match)
- `should: [...]` — OR (at least one must match)
- `must_not: [...]` — NOT (none must match)

## Available fields

**Chunk metadata:** relativePath, fileExtension, language, startLine, endLine, chunkIndex, isDocumentation, name, chunkType, parentSymbolId (class name for code, relative path for docs), parentType, symbolId, navigation, headingPath

**Git metadata** (requires enrichment, two levels):

<!-- data:git-fields -->

**Ownership semantics:** `recentDominantAuthor*` = recent commit activity in log window (TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS); `blameDominantAuthor*` = owner of live HEAD lines (git blame). True ownership / silo detection → the latter.

**⚠ Filter level:** `level` does two things. (1) Scope of level-aware typed filters: effective level (explicit `level`, else rerank preset `signalLevel`) re-scopes all of them; unset → each filter's default: `minAgeDays` / `maxAgeDays` / `minCommitCount` → `git.chunk.*`, `taskId` / `author` → `git.file.*`, codegraph `minFanIn` / `minFanOut` → file. `modifiedAfter` / `modifiedBefore` always read `git.file.lastModifiedAt`, `recentAuthor` always `git.file.recentDominantAuthor*`, `contributor` always `git.file.recentAuthors`, any `level`. (2) Result granularity: `level: "file"` → one result per file, file-level payload only (no chunk fields, no content; outline via `find_symbol(relativePath)`). `minAgeDays` / `maxAgeDays` compare `git.<level>.lastModifiedAt` with query-time now (no drift); chunk timestamp 0 / absent on chunks with no commit in chunk churn walk (all doc chunks) → chunk age filters drop them. Age reads are query-time: overlay `ageDays`, `age`/`recency` rerank and the ageDays filter presets derive from `git.<level>.lastModifiedAt`, never the stamp. Payload `ageDays` stays an enrichment-time stamp (`0` = < 1 day then, not no-data) — only a RAW `ageDays` range inherits that lag.

**Imports:** imports[] — file-level imports

**Codegraph metadata** (requires codegraph indexing — typed filter params, not raw Qdrant keys):

File-level (default level): `minFanIn`, `minFanOut`, `minInstability`, `minTransitiveImpact`, `minConnectionCount`, `isHub` (boolean), `isLeaf` (boolean)

Chunk-level (pass `level: "chunk"` to enable for fanIn/fanOut): `minFanIn`, `minFanOut`, `minPageRank`

Note: codegraph payload nested (`codegraph.symbols.{file,chunk}.codegraph.{file,chunk}.X`) to avoid clashing with same-named file-level signals. Raw Qdrant keys won't resolve — use the typed params above.

## Filter Thresholds

Thresholds vary per codebase. `tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap` → percentile label boundaries of your collection, scoped `source` / `test`:
```
signals["typescript"]["git.file.commitCount"]["source"].labelMap
→ { low: 1, typical: 3, high: 8, extreme: 20 }
```
→ 8 commits = "high" for source there; test code has own thresholds.

All label mappings: `tea-rags://guide/signal-labels`.

## Named filter presets (`{presets}` shorthand)

`filter` takes EITHER a raw Qdrant filter OR `{ presets: "name" }` / `{ presets: "a,b,c" }` (CSV, AND-merged) — mutually exclusive in one object. Named presets = curated adaptive bundles; thresholds resolve from collection percentiles at query time (cold-start fallbacks) → scale per repo. `{presets}` AND-composes with typed params (minAgeDays, language, …).

Catalog (gated by registered trajectories):

- **always available:** `production` (exclude tests/docs/block), `coreLogic` (function/class, no tests), `securityPaths` (auth/crypto/secret/token/… paths)
- **require git:** `freshLegacyEdits`, `fragileSilo`, `panicZone`, `godMethods`, `battleTested`, `abandonedHotspots`
- **require codegraph:** `hubs`, `deadCandidates`, `unstableCore`

**Inventory vs query rule:** hard specific presets (panicZone, abandonedHotspots, …) suit query-absent inventory scans (empty result = valid answer); query-driven triage → rank broadly, no hard specific filter (keeps recall). Hygiene presets (production/coreLogic) safe in any mode; they are rerank-preset defaults (when that default applies: `filter` param description).

## pathPattern

Universal formatting constraint (picomatch, exact match on project-relative `relativePath`). Recipes (negation, dominant-domain exclusion) → `/tea-rags:filter-building`.

- GOOD: `src/auth/**` (a path the user names from the project root — use it as-is, no `**/` prefix)
- GOOD: `**/enrichment/**` (a directory NAME whose depth is unknown)
- GOOD: `{app/services/foo.rb,app/models/bar.rb}` (exact relativePaths from results)
- GOOD: `**/{file1.rb,file2.rb}` (bare file names, any directory)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- BAD: `{file1.rb,file2.rb}`, `services/**` for a bare name (no `**/` → root only; fine when the user named that root-relative path)
- BAD: `/Users/me/project/src/**` (absolute path — never matches)

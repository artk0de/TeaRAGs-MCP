# Harness Context Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans / subagent-driven-development) to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut tea-rags' always-on agent context from ~24–25k to ~6.6k tokens per
session start and compaction by moving reference text and project metrics behind
MCP resources, then package the result for Codex and test it live.

**Architecture:** MCP resources become the canonical on-demand channel
(`tea-rags://guide/*` static, `tea-rags://project/{alias}/*` templates). A CLI
mirror (`tea-rags resource <uri>`) reads the same resources through the
in-process MCP session, so hooks and Claude Code skills get byte-identical text.
Prose is authored once in `.claude-plugin/tea-rags/rules/` and compiled into
`src/mcp/resources/generated/agent-context.ts` by a generator with a drift-guard
test.

**Tech Stack:** TypeScript (Node 24), `@modelcontextprotocol/sdk` (McpServer,
ResourceTemplate, Client, InMemoryTransport), yargs, vitest, bash hook tests,
Codex CLI 0.162.1.

**Spec:** `docs/superpowers/specs/2026-10-23-harness-context-economy-design.md`

## Global Constraints

- Work in worktree `.claude/worktrees/harness-context-economy`, branch
  `worktree-harness-context-economy`. Parallel sessions are active: never
  `npm link`; a bare `npm run build` is allowed.
- Layering (`.claude/rules/domain-boundaries.md`): `mcp/` imports only
  `core/api/public/`; `cli/` imports `bootstrap/`, `core/api/public/`,
  `core/api/index.js`; `cli/` never imports `mcp/`.
- Every commit touching `.claude-plugin/<plugin>/` bumps that plugin's
  `plugin.json` (new skill/rule file → minor, text → patch).
- Agent-facing prose is caveman-compressed
  (`.claude/rules/caveman-compression.md`): skill descriptions `full`, skill
  bodies / rules / resource docs `ultra`; never compress schemas, response
  shapes, code fences, identifiers.
- Commit messages: `type(scope): subject`, scopes from `commit-rules.md` (`mcp`,
  `explore`, `scripts`, `test`, `docs`, `beads`…); `Why:` line when a deep-silo
  file is touched.
- Budgets: server `instructions` ≤ 4,096 chars (first 512 self-contained);
  injected rules ≤ 8,000 bytes in 1 part; digest ≤ 2,500 bytes target (test cap
  9,000 on a 4-language fixture); subagent block ≤ 3,000 bytes target (test cap
  9,000 incl. alias line); skill description ≤ 1,024 chars; `resources/list` ≤
  20 entries.
- Per-task gate: targeted vitest suites + `npx tsc --noEmit` +
  `npx eslint <touched>` + touched `tests/hooks/*.test.sh`.
  `npm run test:coverage` runs ONCE on `main` in Task 16.
- Reindex and MCP reconnect are user-gated; Codex live tests use the worktree
  build directly (`node <worktree>/build/index.js`), not the global link.

---

## Phase A — Dead weight and guards

### Task 1: Drop the PreCompact injection; warn on a stale build

**Files:**

- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (delete the
  `PreCompact` group; add a `check-build-fresh.sh` SessionStart command; bump
  patch)
- Create: `.claude-plugin/tea-rags/scripts/check-build-fresh.sh`
- Test: `tests/hooks/check-build-fresh.test.sh`,
  `tests/hooks/inject-rules.test.sh` (assert no PreCompact group)

**Interfaces:**

- Produces: `check-build-fresh.sh` — reads no stdin; prints one line
  `⚠ tea-rags build is older than its source (build <iso>, last src commit <iso>) — run \`npm
  run build\` in <root>`when`$(tea-rags
  --root)`(or the resolved symlink target of the`tea-rags`binary) holds a`.git`and the newest`src/`commit is newer than`build/index.js`;
  prints nothing otherwise; always exits 0.

- [ ] **Step 1: Write the failing hook test**

```bash
#!/usr/bin/env bash
# tests/hooks/check-build-fresh.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude-plugin/tea-rags/scripts/check-build-fresh.sh"
PLUGIN="$ROOT/.claude-plugin/tea-rags/.claude-plugin/plugin.json"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/pkg/src" "$TMP/pkg/build"
git -C "$TMP/pkg" init -q
echo a > "$TMP/pkg/src/a.ts"; git -C "$TMP/pkg" add . ; GIT_COMMITTER_DATE="2026-10-22T10:00:00" git -C "$TMP/pkg" -c user.email=t@t -c user.name=t commit -qm a
touch -t 202610180000 "$TMP/pkg/build/index.js"

OUT="$(TEA_RAGS_PACKAGE_ROOT="$TMP/pkg" bash "$HOOK" </dev/null)"; RC=$?
[ $RC = 0 ]; note $? "exits 0"
echo "$OUT" | grep -Fq "build is older than its source"; note $? "warns when build predates last src commit"

touch -t 202610230000 "$TMP/pkg/build/index.js"
[ -z "$(TEA_RAGS_PACKAGE_ROOT="$TMP/pkg" bash "$HOOK" </dev/null)" ]; note $? "silent when build is fresh"

rm -rf "$TMP/pkg/.git"
[ -z "$(TEA_RAGS_PACKAGE_ROOT="$TMP/pkg" bash "$HOOK" </dev/null)" ]; note $? "silent for a published install (no .git)"

[ "$(jq '.hooks.PreCompact // empty | length' "$PLUGIN")" = "" ]; note $? "plugin.json has no PreCompact group"
jq -r '.hooks.SessionStart[].hooks[].command' "$PLUGIN" | grep -Fq "check-build-fresh.sh"; note $? "SessionStart runs check-build-fresh.sh"

echo "# pass=$PASS fail=$FAIL"; [ $FAIL = 0 ]
```

- [ ] **Step 2: Run it — expect FAIL**
      (`bash tests/hooks/check-build-fresh.test.sh`: hook missing, PreCompact
      present).

- [ ] **Step 3: Implement the hook**

```bash
#!/usr/bin/env bash
# SessionStart: hooks follow the repo HEAD, the CLI follows the last build. A dev
# install (global link → repo) with a stale build/ drifts silently from the
# hooks that call it. Warn once; never fail the session.
ROOT="${TEA_RAGS_PACKAGE_ROOT:-}"
if [ -z "$ROOT" ]; then
  BIN="$(command -v tea-rags 2>/dev/null)" || exit 0
  REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$BIN" 2>/dev/null)" || exit 0
  ROOT="$(cd "$(dirname "$REAL")/.." 2>/dev/null && pwd)" || exit 0
fi
[ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ] || exit 0
[ -f "$ROOT/build/index.js" ] || exit 0
SRC_TS="$(git -C "$ROOT" log -1 --format=%ct -- src 2>/dev/null)"; [ -n "$SRC_TS" ] || exit 0
BUILD_TS="$(stat -f %m "$ROOT/build/index.js" 2>/dev/null || stat -c %Y "$ROOT/build/index.js" 2>/dev/null)" || exit 0
if [ "$SRC_TS" -gt "$BUILD_TS" ]; then
  iso() { date -r "$1" -u +%FT%TZ 2>/dev/null || date -d "@$1" -u +%FT%TZ; }
  echo "⚠ tea-rags build is older than its source (build $(iso "$BUILD_TS"), last src commit $(iso "$SRC_TS")) — run \`npm run build\` in $ROOT"
fi
exit 0
```

Edit `plugin.json`: delete the whole `"PreCompact": [...]` array; append
`{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/check-build-fresh.sh", "timeout": 5 }`
as the LAST SessionStart command; bump `version` patch. Update the
`inject-rules.sh` header comment (it claims PreCompact callers).

- [ ] **Step 4: Run**
      `bash tests/hooks/check-build-fresh.test.sh && bash tests/hooks/inject-rules.test.sh`
      — expect all `ok`.
- [ ] **Step 5: Commit** —
      `fix(scripts): drop the PreCompact rule injection that never reaches the model; warn on a stale dev build`

---

### Task 2: Size guards and over-long skill descriptions

**Files:**

- Create: `tests/hooks/agent-context-budgets.test.sh`
- Modify:
  `.claude-plugin/tea-rags/skills/{filter-building,architecture-diagnostics,analytics-rerank}/SKILL.md`
  (descriptions ≤ 1,024 chars; patch bump)

**Interfaces:**

- Produces: `agent-context-budgets.test.sh` — the single place later tasks
  tighten caps (Task 8 drops the rules cap to 8,000/1 part, Task 9 drops the
  subagent cap to 3,000).

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# tests/hooks/agent-context-budgets.test.sh — overflow past a harness cap is silent
# (Claude Code: 10,000 chars → 2,000-char preview), so every always-on artifact
# carries a byte budget here.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

SUBAGENT_CAP=9000
INPUT='{"session_id":"s","hook_event_name":"SubagentStart","agent_type":"general-purpose"}'
BLOCK="$(echo "$INPUT" | bash "$ROOT/.claude-plugin/tea-rags/scripts/enforce-tearags-search.sh" | jq -r '.hookSpecificOutput.additionalContext')"
[ "$(printf %s "$BLOCK" | wc -c)" -le $SUBAGENT_CAP ]; note $? "subagent block ≤ $SUBAGENT_CAP bytes"

for f in "$ROOT"/.claude-plugin/*/skills/*/SKILL.md; do
  LEN="$(node -e '
    const t=require("fs").readFileSync(process.argv[1],"utf8");
    const m=t.match(/^---\n([\s\S]*?)\n---/); if(!m){console.log(0);process.exit()}
    const d=m[1].match(/^description:\s*([\s\S]*?)(?=^\w[\w-]*:|$(?![\s\S]))/m);
    console.log(d?d[1].replace(/\s+/g," ").trim().length:0)' "$f")"
  [ "$LEN" -le 1024 ]; note $? "description ≤ 1024 chars: ${f#$ROOT/} ($LEN)"
done
echo "# pass=$PASS fail=$FAIL"; [ $FAIL = 0 ]
```

- [ ] **Step 2: Run — expect FAIL** on the three descriptions (1,585 / 1,203 /
      1,113).
- [ ] **Step 3: Trim the three descriptions** to ≤ 1,024 chars at caveman
      `full`: keep the positive trigger core, quoted trigger phrases and every
      `NOT for X (use Y)` boundary; drop duplicated synonyms. Patch-bump
      tea-rags `plugin.json`.
- [ ] **Step 4: Run** the budgets test and
      `bash tests/hooks/check-plugin-version.test.sh` — expect all `ok`.
- [ ] **Step 5: Commit** —
      `test(scripts): byte budgets for always-on agent context; trim three skill descriptions under 1,024 chars`

---

## Phase B — Resources and the CLI mirror

### Task 3: `readResource` on the in-process session; `tea-rags resource <uri>`

**Files:**

- Modify: `src/bootstrap/transport/in-memory.ts` (`InProcessToolSession` gains
  `readResource`, `listResources`)
- Modify: `src/bootstrap/transport/in-process-session.ts` (pass them through)
- Create: `src/cli/commands/resource.ts`
- Modify: `src/cli/index.ts` (or wherever commands register — follow `call.ts`'s
  registration)
- Test: `tests/bootstrap/transport/in-memory.test.ts`,
  `tests/cli/commands/resource.test.ts`

**Interfaces:**

- Produces:
  - `InProcessToolSession.readResource(uri: string): Promise<ReadResourceResult>`
  - Delivered (7d25bc095):
    `listResourceTemplates(): Promise<ResourceTemplate[]>` too;
    `runResource(input: RunResourceArgs): Promise<number>` with optional `list`,
    `out`, `errOut`; alias via `resolveProjectAlias` in
    `src/cli/commands/project.ts`; registry env replayed like `call`; CLI entry
    is `build/cli/index.js` (`build/index.js` is the stdio server).
  - `InProcessToolSession.listResources(): Promise<Resource[]>` (follows
    `nextCursor`, like `listTools`)
  - CLI: `tea-rags resource <uri> [--path <dir>] [--project <alias>] [--json]`;
    `tea-rags resource --list` prints every `listResources()` URI plus every
    registered template URI, one per line. `<uri>` may contain the literal
    `{alias}`; it is replaced by the alias resolved from `--project`, else
    `--path` (default `process.cwd()`) via the same registry lookup
    `project exist --repository` uses (`findRepositoryEntry`,
    `src/cli/commands/project.ts`). Prints the text of every `contents[]` item
    (plain) or the raw result (`--json`). Unknown resource → stderr message,
    exit 1. Exported for tests:
    `runResource(input: { uri: string; path?: string; project?: string; json?: boolean; session?: InProcessToolSession; resolveAlias?: (input:{path?:string;project?:string}) => Promise<string|null> }): Promise<number>`.

- [ ] **Step 1: Failing transport test** — in
      `tests/bootstrap/transport/in-memory.test.ts` build an `McpServer`,
      register
      `server.registerResource("x", "tea-rags://guide/x", { mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# X" }] }))`,
      connect with `connectInProcessClient`, assert
      `(await s.readResource("tea-rags://guide/x")).contents[0].text === "# X"`
      and `(await s.listResources()).map(r => r.uri)` contains it.
- [ ] **Step 2: Run**
      `npx vitest run tests/bootstrap/transport/in-memory.test.ts` — FAIL
      (`readResource` not a function).
- [ ] **Step 3: Implement**

```ts
// in-memory.ts — interface additions
readResource: (uri: string) => Promise<ReadResourceResult>;
listResources: () => Promise<Resource[]>;

// connectInProcessClient — returned object additions
readResource: async (uri) => client.readResource({ uri }, { timeout: CALL_TIMEOUT_MS }),
listResources: async () => {
  const resources: Resource[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor === undefined ? {} : { cursor });
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return resources;
},
```

`in-process-session.ts`: add
`readResource: session.readResource, listResources: session.listResources` next
to `listTools`/`callTool`.

- [ ] **Step 4: Failing CLI test** — `tests/cli/commands/resource.test.ts`: fake
      session whose `readResource` echoes the uri; assert
      `runResource({ uri: "tea-rags://project/{alias}/digest", project: "tea-rags", session, resolveAlias: async () => "tea-rags" })`
      writes text and returns 0, that `{alias}` became `tea-rags`, and that an
      unresolvable alias returns 1 with a stderr hint
      `register the project: tea-rags index-codebase --name <alias>`.
- [ ] **Step 5: Implement `resource.ts`** mirroring `call.ts` (yargs command,
      `openInProcessMcpSession`, always `close()` in `finally`,
      `process.exit(code)` in the handler like `prime`).
- [ ] **Step 6: Run** both test files + `npx tsc --noEmit` — PASS.
- [ ] **Step 7: Commit** —
      `feat(mcp): tea-rags resource <uri> reads MCP resources through the in-process session`

---

### Task 4: Agent-context generator and the `tea-rags://guide/*` namespace

**Files:**

- Create: `scripts/gen-agent-context.ts`
- Create: `src/mcp/resources/generated/agent-context.ts` (generated; header
  `// GENERATED by npm run gen:agent-context — DO NOT EDIT`)
- Create: `.claude-plugin/tea-rags/rules/guides/.gitkeep` (Task 8 fills it)
- Modify: `src/mcp/resources/registry.ts` (guide registrations, schema aliases,
  drop the collection `list` callback)
- Modify: `package.json`
  (`"gen:agent-context": "tsx scripts/gen-agent-context.ts"`)
- Test: `tests/mcp/resources/agent-context-drift.test.ts`,
  `tests/mcp/resources/guides.test.ts`

**Interfaces:**

- Produces:
  - `AGENT_CONTEXT_CORE: string` and
    `AGENT_CONTEXT_GUIDES: Readonly<Record<string, string>>` exported from
    `src/mcp/resources/generated/agent-context.ts` (keys = guide file basenames
    without `.md`).
  - `renderAgentContextModule(rulesDir: string): string` exported from
    `scripts/gen-agent-context.ts` — the drift test compares it to the committed
    file.
  - Registered URIs:
    `tea-rags://guide/{core, navigation, decision-tree, freshness, degraded}`
    from markdown (present only when the guide file exists), plus builder-backed
    `tea-rags://guide/{overview, presets, signals, filters, search-examples, indexing, signal-labels, language-capability}`.
    `tea-rags://schema/{overview, presets, signals, filters, search-guide, indexing-guide, signal-labels}`
    stay registered, same builders, description prefixed
    `Deprecated alias of tea-rags://guide/<x>.`
  - `qdrant://collection/{name}` keeps reads; its template has
    `list: undefined`.

- [ ] **Step 1: Failing drift test**

```ts
// tests/mcp/resources/agent-context-drift.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderAgentContextModule } from "../../../scripts/gen-agent-context.js";

describe("generated agent context", () => {
  it("matches the markdown it is generated from", () => {
    const root = resolve(__dirname, "../../..");
    const committed = readFileSync(
      resolve(root, "src/mcp/resources/generated/agent-context.ts"),
      "utf8",
    );
    expect(committed).toBe(
      renderAgentContextModule(resolve(root, ".claude-plugin/tea-rags/rules")),
    );
  });
});
```

- [ ] **Step 2: Failing registry test** (`guides.test.ts`): register resources
      on an `McpServer` with a stub `App` (`getSchemaDescriptors` returning the
      fixture used by `resources.test.ts`, `listCollections` → 46 names),
      connect via `connectInProcessClient`, assert: `listResources()` length ≤
      20 and contains no `qdrant://collection/` entry;
      `readResource("tea-rags://guide/filters")` text equals
      `readResource("tea-rags://schema/filters")` text;
      `readResource("tea-rags://guide/language-capability")` contains
      `## Matrix` and NOT `For humans`.
- [ ] **Step 3: Run** both — FAIL.
- [ ] **Step 4: Implement the generator**

```ts
// scripts/gen-agent-context.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const HEADER =
  "// GENERATED by `npm run gen:agent-context` from .claude-plugin/tea-rags/rules — DO NOT EDIT.\n";

export function renderAgentContextModule(rulesDir: string): string {
  const corePath = resolve(rulesDir, "core.md");
  const core = existsSync(corePath) ? readFileSync(corePath, "utf8") : "";
  const guidesDir = resolve(rulesDir, "guides");
  const guides = existsSync(guidesDir)
    ? readdirSync(guidesDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
  const entries = guides
    .map(
      (f) =>
        `  ${JSON.stringify(basename(f, ".md"))}: ${JSON.stringify(readFileSync(resolve(guidesDir, f), "utf8"))},`,
    )
    .join("\n");
  return `${HEADER}\nexport const AGENT_CONTEXT_CORE = ${JSON.stringify(core)};\n\nexport const AGENT_CONTEXT_GUIDES: Readonly<Record<string, string>> = {\n${entries}\n};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, "..");
  writeFileSync(
    resolve(root, "src/mcp/resources/generated/agent-context.ts"),
    renderAgentContextModule(resolve(root, ".claude-plugin/tea-rags/rules")),
  );
}
```

Run `npm run gen:agent-context` (empty core + no guides at this point is valid).

- [ ] **Step 5: Implement registrations** in `registry.ts`: one helper
      `registerMarkdown(server, name, uri, title, description, render: () => string)`
      used for every static doc; register `guide/*` from builders
      (`language-capability` = `renderRule(...)` from
      `src/core/domains/language/capability/rule.ts` reached through
      `core/api/public` — add the public re-export if it is not there, minus the
      `## For humans` section); register `guide/<key>` for each
      `AGENT_CONTEXT_GUIDES` key and `guide/core` when `AGENT_CONTEXT_CORE` is
      non-empty; re-register `schema/*` as aliases; set the collection template
      `list` to `undefined`. Resource docs are caveman `ultra` where prose is
      new.
- [ ] **Step 6: Run** `npx vitest run tests/mcp/resources` + `npx tsc --noEmit`
      — PASS.
- [ ] **Step 7: Commit** —
      `feat(mcp): tea-rags://guide/* resource namespace generated from the plugin rules; drop the per-collection resource listing`

---

### Task 5: Project resources — digest and metrics templates

**Files:**

- Create: `src/mcp/resources/project/digest.ts` (moved digest formatters)
- Create: `src/mcp/resources/project/metrics.ts` (thresholds / labelMap /
  capability / resolve / registry sections)
- Create: `src/mcp/resources/project/register.ts`
- Modify: `src/mcp/resources/registry.ts` (call `registerProjectResources`)
- Create: `src/mcp/resources/project/languages.ts` (language split, capability
  and resolve formatters shared by digest and metrics)
- Unchanged: `src/cli/prime/format.ts` and its `format-*.test.ts` — `cli` may
  not import `mcp`, so the formatters are copied, not moved; the cli copy and
  its tests are deleted/rewired in Task 6 once prime reads the resource
- Test: `tests/mcp/resources/project-digest.test.ts`,
  `tests/mcp/resources/project-metrics.test.ts`,
  `tests/mcp/resources/project/fixture.ts`

**Interfaces:**

- Consumes: `App.getIndexStatus(path)`, `App.getIndexMetrics(path)`,
  `App.checkIndexDrift({ path, consume: false })`,
  `App.getCollectionMemory(name)`, `App.resolveLanguageCapabilities(langs)`, and
  the registry lookup by alias the server already uses for `project:` addressing
  (find it via `find_symbol` on the `project` param resolver; do not add a
  second resolver).
- Produces:
  - `formatSlimDigest(data: ProjectDigestData, now: Date): string` — sections in
    order: `# tea-rags digest — <alias>`, Status line, `name:` + hint, stale
    banner (+ auto-update cure line when given), `## Drift`, Polyglot line,
    Language capability lines, Codegraph resolve ⚠ lines only, Infra/Enrichment
    only when not healthy, closing line
    `→ thresholds / labelMap: tea-rags://project/<alias>/metrics?language=<lang>`.
  - `formatProjectMetrics(data: ProjectDigestData, query: { language?: string; section?: string[] }): string`.
  - `ProjectDigestData` = today's `PrimeData` minus `update` /
    `autoUpdateOutcome` / `autoUpdateLogPath` (those stay CLI-side), defined in
    `src/mcp/resources/project/types.ts`.
  - URIs: `tea-rags://project/{alias}/digest`,
    `tea-rags://project/{alias}/metrics{?language,section}` (`section` comma
    list; default all; `language` default every primary language).

- [ ] **Step 1: Failing digest test** — fixture with 4 primary languages (ruby,
      typescript, python, go), each with a full thresholds bucket; assert
      `formatSlimDigest(...)` byte length ≤ 2,500, contains `## Drift`, the
      stale banner when `lastUpdated` is 3 days old, and does NOT contain
      `Signal thresholds`.
- [ ] **Step 2: Failing metrics test** — same fixture;
      `formatProjectMetrics(d, { language: "ruby", section: ["thresholds"] })`
      contains the ruby thresholds table header that `formatThresholdsSection`
      emits at `9a9a9e4ad` and no `typescript`; size ≤ 5,000 bytes.
- [ ] **Step 3: Failing template test** — register on a stub App;
      `readResource("tea-rags://project/fixture/digest")` returns the slim
      digest; `readResource("tea-rags://project/unknown/digest")` returns a text
      `project 'unknown' not registered` (no throw).
- [ ] **Step 4: Run** — FAIL.
- [ ] **Step 5: Implement** — move the formatters with `git mv`-equivalent edits
      (keep function bodies byte-identical where they move); `register.ts` uses
      `new ResourceTemplate("tea-rags://project/{alias}/digest", { list: undefined })`
      and
      `ResourceTemplate("tea-rags://project/{alias}/metrics{?language,section}", { list: undefined })`.
      Build `ProjectDigestData` with the same `Promise.allSettled` fan-out
      `runPrime` uses.
- [ ] **Step 6: Run** `npx vitest run tests/mcp/resources tests/cli/prime` +
      `npx tsc --noEmit` — PASS (moved prime tests pass from their new
      location).
- [ ] **Step 7: Commit** —
      `feat(mcp): project digest and metrics resource templates`

---

### Task 6: `tea-rags prime` reads the digest resource

**Files:**

- Modify: `src/cli/prime/run-prime.ts`, `src/cli/commands/prime.ts` (`--full`)
- Modify: `src/cli/prime/format.ts` (only CLI lines remain: path-not-found,
  qdrant-cold, failure, update, auto-update)
- Delete from `format.ts` the formatters Task 5 copied into
  `src/mcp/resources/project/`; move the `format-*.test.ts` cases that cover
  them to `tests/mcp/resources/project/` (examples preserved) or drop the ones
  the digest no longer renders
- Modify: `src/mcp/resources/project/register.ts` — the SDK matches a query
  template only when every listed parameter is present, so
  `metrics{?language,section}` alone rejects `/metrics` and `?language=<lang>`
  (the digest's own pointer); register one template per accepted shape. Alias
  falls back to the collection name for a registry entry without a name; a typed
  status failure keeps its code and hint.
- Test: `tests/cli/commands/prime.test.ts`,
  `tests/cli/prime/run-prime-digest.test.ts`,
  `tests/cli/prime/format-auto-update.test.ts`; relocated formatter cases under
  `tests/mcp/resources/project/*.test.ts`

**Interfaces:**

- Consumes:
  `openInProcessMcpSession().readResource("tea-rags://project/<alias>/digest")`
  (Task 3), `formatSlimDigest` output (Task 5).
- Produces: `tea-rags prime [path] [--project] [--full]` — default output =
  digest resource text + CLI lines (update notice, auto-update verdict) +
  closing `→ run \`tea-rags prime "$CLAUDE_PROJECT_DIR"\` to
  refresh`; `--full`appends`tea-rags://project/<alias>/metrics`. Keeps today's `path-not-found`and`qdrant-cold`outputs and the registry env replay BEFORE the session opens. A path no registry entry claims has no alias to read: prime prints the`not
  indexed` placeholder without opening a session.

- [ ] **Step 1: Failing test** — `prime.test.ts`: with a fake session returning
      a 2,000-byte digest, assert stdout = digest + update line; with `--full`,
      metrics text follows; with Qdrant unreachable, the existing `qdrant-cold`
      text and no session opened.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; keep `process.exit(0)` in the handler.
- [ ] **Step 4: Run** `npx vitest run tests/cli` + `npx tsc --noEmit` — PASS.
      Then
      `npm run build && node build/cli/index.js prime /Users/artk0re/Dev/Job/taxdome | wc -c`
      — expect ≤ 2,700.
- [ ] **Step 5: Commit** —
      `improve(explore): prime prints the slim project digest; --full keeps thresholds for humans`

---

### Task 7: Server `instructions` (isolated: `factory.ts`, blast radius 16)

**Files:**

- Modify: `src/bootstrap/factory.ts` (`createConfiguredServer`:
  `new McpServer({ name, version }, { instructions: AGENT_CONTEXT_CORE || undefined })`)
- Test: `tests/bootstrap/factory-instructions.test.ts`

**Interfaces:**

- Consumes: `AGENT_CONTEXT_CORE` (Task 4) — re-exported for bootstrap through
  `src/mcp/resources/index.js` (bootstrap may import `mcp/`).

- [ ] **Step 1: Failing test** — build the server via `createConfiguredServer`
      with the minimal ctx the existing factory tests use; connect
      `connectInProcessClient`; read `client.getInstructions()` (expose it on
      the session as `instructions(): string | undefined` if needed) — expect it
      to equal `AGENT_CONTEXT_CORE`, length ≤ 4,096, and `slice(0,512)` to
      contain `project=` and `path=`.
- [ ] **Step 2: Run** — FAIL (no instructions).
- [ ] **Step 3: Implement** (one-line constructor change + import).
- [ ] **Step 4: Run** the new test + `npx vitest run tests/bootstrap` +
      `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** —
      `feat(mcp): server instructions carry the always-on tea-rags core` with
      `Why:` line (deep-silo file).

---

### Task 8: Split the rules — `core.md` injected, guides served

**Files:**

- Create: `.claude-plugin/tea-rags/rules/core.md` (≤ 3,700 chars — server
  `instructions` cap 4,096 and Cursor's `tea-rags-core.mdc` cap 4,096 incl. ~330
  chars of wrapper; the spec's core outline)
- Create:
  `.claude-plugin/tea-rags/rules/guides/{navigation,decision-tree,freshness,degraded}.md`
  (bodies moved out of `search-cascade.md` / `index-freshness.md`, caveman
  ultra)
- Delete: `.claude-plugin/tea-rags/rules/search-cascade.md`,
  `rules/index-freshness.md` (content now in core + guides)
- Modify: `scripts/gen-language-compatibility.ts` (stop writing
  `rules/language-compatibility.md`; the `guide/language-capability` resource
  replaces it; keep the README block) — delete
  `rules/language-compatibility.md`; retarget
  `tests/core/domains/language/capability/drift-guard.test.ts`
- Modify: `.claude-plugin/tea-rags/scripts/inject-rules.sh`
  (`RULE_FILES="core.md"`), `plugin.json` (one SessionStart inject command,
  `--part 1 --parts 1`; minor bump — rule files added/removed)
- Modify: every reference to the deleted files
  (`grep -rn "search-cascade.md\|index-freshness.md\|language-compatibility.md" .claude-plugin .claude src docs README.md`
  via ripgrep MCP) → point to `tea-rags://guide/<topic>`
- Modify: `.claude/rules/plugin-guidance-layers.md`,
  `src/mcp/resources/generated/agent-context.ts` (regenerated)
- Modify: `src/mcp/resources/registry.ts` — the seven `tea-rags://schema/*`
  aliases collapse into one unlisted template `tea-rags://schema/{name}`
  (`list: undefined`): with core + 4 guides the static listing reaches 20, and
  Task 5's two project templates count against the same ≤ 20 budget
  (`tests/mcp/resources/guides.test.ts` counts resources + templates)
- Test: `tests/hooks/agent-context-budgets.test.sh` (add: inject output ≤ 8,000
  bytes, `--count` = 1, `core.md` ≤ 3,700 chars),
  `tests/hooks/inject-rules.test.sh`

- [ ] **Step 1: Tighten the budget test** (inject total ≤ 8,000 bytes;
      `inject-rules.sh --count` prints 1) — run → FAIL.
- [ ] **Step 2: Write `core.md`** in this order: (1) addressing
      (`project=<alias>` + `path=<cwd>` on every read call; `index_codebase`
      takes `project` only); (2) routing table (single file →
      `find_symbol(relativePath)`; symbol → `find_symbol`; usages →
      `hybrid_search`; intent → `semantic_search`; analog → `find_similar`;
      impact → `get_callers` / `trace_path`; literal text → ripgrep; never
      Grep/Glob/Bash over code); (3) invariants (no `Read` after `find_symbol`;
      lag/drift never licenses leaving tea-rags; empty `get_callers` under low
      resolve ≠ absence; `#partN` → fetch parent); (4) triggers: after any
      search → `tea-rags://guide/navigation`; before raw `filter:` →
      `guide/filters`; before rerank choice → `guide/presets` + `guide/signals`;
      stale/drift/`treeState` → `guide/freshness`; embedding/qdrant error →
      `guide/degraded`; graph trust on non-primary language →
      `guide/language-capability`; no digest in context →
      `tea-rags://project/<alias>/digest`; thresholds/labelMap →
      `tea-rags://project/<alias>/metrics?language=<lang>`; (5) destructive
      tools need consent (`force_reindex`, `clear_index`, `delete_*`). Keep it ≤
      3,700 chars — it doubles as server `instructions` and Cursor's core rule.
- [ ] **Step 3: Move the bodies** into the four guide files
      verbatim-then-compressed (sections listed in the spec's classification);
      delete `For humans — resolution tech` from agent context (it already lives
      in README).
- [ ] **Step 4: Regenerate**
      `npm run gen:agent-context && npm run gen:lang-compat`; update references;
      update `plugin-guidance-layers.md` (four layers become: prime/digest =
      state; tool schema = contract; resources = reference + guides; core =
      always-on policy).
- [ ] **Step 5: Run** all `tests/hooks/*.test.sh`,
      `npx vitest run tests/mcp/resources tests/core/domains/language/capability`
      — PASS.
- [ ] **Step 6: Commit** —
      `improve(explore): always-on core shrinks to one part; navigation, freshness and decision-tree guides move behind tea-rags://guide/*`

---

### Task 9: Subagent block ≤ 3KB; dinopowers routing once per session

> Carry-over from Task 13: the block still names Claude-only tools (Grep / Glob,
> `mcp__ripgrep__search`); the Codex/Cursor transforms only rewrite the
> `mcp__tea-rags__` prefix. Rewrite those lines harness-neutrally here, then
> regenerate both harness packages.

**Files:**

- Modify: `.claude-plugin/tea-rags/rules/references/subagent-injection.md`
  (block ≤ 2,800 bytes: addressing + routing + Bash ban + `guide/navigation`
  trigger)
- Modify: `.claude-plugin/dinopowers/.claude-plugin/plugin.json`
  (UserPromptSubmit → SessionStart; minor bump),
  `.claude-plugin/dinopowers/scripts/inject-main-session-routing.sh` (emit
  SessionStart `additionalContext`; never echo the prompt)
- Test: `tests/hooks/agent-context-budgets.test.sh` (subagent cap 3,000),
  `tests/hooks/subagent-context.test.sh`, new case in
  `tests/hooks/agent-context-budgets.test.sh`: main-session routing output ≤
  2,500 bytes and does not contain the input prompt text

- [ ] **Step 1: Tighten tests** — run → FAIL.
- [ ] **Step 2: Rewrite the block** (keep the `## Search Tools (MANDATORY`
      heading the existing test greps for) and the routing hook.
- [ ] **Step 3: Run** hook tests — PASS. Bump both plugins.
- [ ] **Step 4: Commit** —
      `improve(scripts): subagent block under 3KB; dinopowers routing injected once per session`

---

## Phase C — Skills: dead weight, decomposition, resources, full eval

Per skill the same four passes, in order: **(1) dead weight** — delete text that
duplicates core/guides/resources, stale stats, repeated warnings; **(2)
decomposition** — SKILL.md keeps trigger, phase order, gates, output template;
self-contained reference blocks move to `references/<topic>.md` (Agent Skills
target: body < 500 lines); **(3) resources** — inline catalogs become a
guide/metrics read; skills whose need is unconditional and ≤ 8KB inline it at
load in Claude Code via
`` !`tea-rags resource "tea-rags://project/{alias}/metrics?section=<s>" --path "$PWD" || true` ``
(no `language=` — unknown at load time, so every indexed language comes in) and
ALSO keep the model-read line
`Need thresholds → read tea-rags://project/<alias>/metrics?…` (other harnesses
have no load-time shell); **(4) compress** to caveman `ultra` (bodies) / `full`
(descriptions). Before/after bytes recorded per skill in the task's commit
message body.

### Task 10: Data-consuming and oversized tea-rags skills

**Files (modify; `references/` created where listed):**

- `skills/tests-as-context/SKILL.md` — load-time inline `section=thresholds`;
  delete "Read prime digest… / probe" fallback branch (SKILL.md:50,90)
- `skills/bug-hunt/SKILL.md` — inline `section=thresholds,resolve`
- `skills/risk-assessment/SKILL.md` — inline `section=labelMap,resolve`; Phase 4
  ENRICH → `references/enrich.md`
- `skills/filter-building/SKILL.md` — delete "Typed filters" + "Named filter
  presets" bodies; inline
  `` !`tea-rags resource tea-rags://guide/filters || true` ``
- `skills/analytics-rerank/SKILL.md` — URIs `schema/*` → `guide/*`
- `skills/pattern-search/SKILL.md` — model-read
  `project/<alias>/metrics?section=labelMap` when filtering by label
- `skills/data-driven-generation/SKILL.md` — the long `## Workflow` steps (5
  STYLE, 6 GENERATE, 7 VERIFY) → `references/step-<n>-<name>.md`; short Steps
  1–4 and 8 stay inline (read every run — a file per step costs a read each);
  labels/thresholds via metrics resource; keep Steps 1–7 headers + gates in
  SKILL.md
- `skills/architecture-diagnostics/SKILL.md` — each `## Phase 3x` body →
  `references/phase-3x-<name>.md`; Phase 1 response semantics, Phase 4
  exclusions and the full anti-pattern list → `references/` too (3x alone left
  ~24KB); SKILL.md ≤ 15KB; Phase 0 gate reads `metrics?section=resolve`
- Plugin: tea-rags `plugin.json` minor bump (new reference files)
- Test: `tests/hooks/skill-size-budgets.test.sh` per-skill caps (tea-rags
  SKILL.md ≤ 20KB each; architecture-diagnostics ≤ 15KB) — own file, since Task
  9 edits `agent-context-budgets.test.sh` in parallel;
  `tests/hooks/skill-resource-refs.test.sh` (every `tea-rags://` URI written in
  a skill is one the server registers — compare against
  `node build/cli/index.js resource --list` output)

- [ ] **Step 1: Write the two tests** — run → FAIL (sizes; `schema/*` still
      referenced is allowed until a later deprecation release, but unknown URIs
      fail).
- [ ] **Step 2–9: One step per skill** applying the four passes; after each
      skill run the two tests.
- [ ] **Step 10: Commit per skill or per pair** —
      `improve(explore): <skill> — dead weight out, references split, project data via resources (<before>→<after> bytes)`

### Task 11: Remaining skills (tea-rags, dinopowers, tea-rags-setup)

**Files:** every other `SKILL.md` under
`.claude-plugin/{tea-rags,dinopowers,tea-rags-setup}/skills/` and
`.claude-plugin/dinopowers/{CHAINING,FRESHNESS}.md`, `rules/references/*.md`.

- [ ] **Step 1:** Inventory with sizes (`wc -c`) and every mention of
      `prime digest`, `search-cascade.md`, `index-freshness.md`,
      `ReadMcpResourceTool`, `schema/` → table in the commit body.
- [ ] **Step 2:** Apply passes (1)–(4); replace "read prime digest section X"
      with the digest/metrics resource; harness-specific tool names stay only
      where the skill is Claude-only (Task 13 transforms them for Codex).
- [ ] **Step 3:** Run all hook tests + `check-plugin-version.test.sh`; bump all
      three plugins.
- [ ] **Step 4:** Commit per plugin — `improve(explore): dinopowers skills — …`
      etc.

### Task 12: Full eval run (gate for Phase C)

**Files:** `.claude-plugin/.benchmarks/<suite>/benchmark.md` (append a dated row
per suite), `.claude-plugin/.benchmarks/README.md` (summary row
`harness-context-economy`),
`.claude-plugin/.benchmarks/harness-context-economy/benchmark.md` (new:
always-on bytes before/after, per-suite pass rates).

- [ ] **Step 1:** Enumerate suites with an `evals.json`
      (`ls .claude-plugin/.benchmarks/*/evals.json .claude-plugin/.benchmarks/*/workspace/evals.json`);
      record case counts.
- [ ] **Step 2:** For each suite run the with-skill eval per `/optimize-skill`
      Phase 4 against the NEW plugin text (subagents get the new core + digest
      as their injected context, exactly what SessionStart now emits; `sonnet`
      subjects unless the suite's benchmark names another model). Batch suites ≤
      6 parallel agents; each agent ≤ 150k tokens.
- [ ] **Step 3:** Compare against each suite's last recorded with-skill rate.
      Any regression → fix in the skill/core/guide (not the eval), re-run that
      suite only.
- [ ] **Step 4:** Persist results (benchmark.md rows + new summary benchmark).
- [ ] **Step 5:** Commit —
      `test(beads): full eval run after the context-economy rewrite`

---

## Phase D — Codex and Cursor harnesses

### Task 13: Generate the Codex package

**Files:**

Facts (sourced, with open items):
`docs/superpowers/specs/2026-10-23-harness-facts.md` §A. Codex plugins bundle
skills, MCP servers and hooks — NOT AGENTS.md; hook commands get `PLUGIN_ROOT`;
plugin hooks need trust (`/hooks`) or `--dangerously-bypass-hook-trust`; the
skills list gets ~2% of context (8,000 chars default), so the package ships a
curated skill set with short descriptions.

**Files:**

- Create: `scripts/gen-harness-codex.ts`
- Create (generated): `harness/codex/tea-rags/.codex-plugin/plugin.json`
  (`name`, `version`, `description`, `skills: "./skills/"`,
  `mcpServers: "./.mcp.json"`, `hooks: "./hooks/hooks.json"`),
  `harness/codex/tea-rags/.mcp.json`, `harness/codex/tea-rags/hooks/hooks.json`,
  `harness/codex/tea-rags/skills/<skill>/SKILL.md` (+ `references/`),
  `harness/codex/tea-rags/skills/tea-rags-core/SKILL.md` (the core as an
  always-relevant skill), `harness/codex/AGENTS.tea-rags.md` (core snippet for
  the user's AGENTS.md), `harness/codex/marketplace.json` (local marketplace
  entry), `harness/codex/README.md` (install steps + facts excerpt)
- Test: `tests/scripts/gen-harness-codex.test.ts` (drift guard + transforms +
  skills-list budget)

**Interfaces:**

- Consumes: `.claude-plugin/{tea-rags,dinopowers}/skills/**`, `rules/core.md`.
- Produces:
  - Skill transform rules (pure function `toCodexSkill(md: string): string`):
    drop `` !`…` `` load-time blocks (keep the model-read line beside them);
    `ReadMcpResourceTool(server: "tea-rags", uri: X)` →
    `read_mcp_resource(server: "tea-rags", uri: X)`; `mcp__tea-rags__<tool>` →
    bare `<tool>` (Codex may or may not prefix; bare names read either way);
    `Skill(tea-rags:<s>)` / `/tea-rags:<s>` → `$<s>`; `Agent` tool /
    `subagent_type` passages → "spawn a subagent"; `AskUserQuestion` → "ask the
    user". Frontmatter keeps `name` + `description` only.
  - Curated skill set: tea-rags user-facing skills only (dinopowers wrappers
    chain into superpowers, which Codex does not ship — excluded); total of
    `name + description` across shipped skills ≤ 7,000 chars (test-enforced).
  - `.mcp.json`:
    `{ "mcpServers": { "tea-rags": { "type": "stdio", "command": "tea-rags", "args": ["server"], "default_tools_approval_mode": "approve" } } }`
    (field names per facts §A.3; dev override documented in README:
    `command: "node", args: ["<repo>/build/index.js"]`).
  - `hooks/hooks.json`: SessionStart → `tea-rags prime "$PWD"` (plain stdout is
    context; ≤ 2,500-token cap is met by the slim digest); SubagentStart →
    `${PLUGIN_ROOT}/scripts/subagent-block.sh` (copied from the Claude plugin
    hook, emitting `hookSpecificOutput.additionalContext`).

- [ ] **Step 1: Pin the facts in `harness/codex/README.md`** — copy the relevant
      §A facts with sources; re-verify locally the two open items the generator
      depends on: `codex plugin --help` (marketplace add / plugin add commands)
      and whether `.mcp.json` server entries need `type`.
- [ ] **Step 2: Failing test** — transforms on a fixture skill (each rule
      above) + drift guard (`renderCodexHarness(root)` equals committed files).
- [ ] **Step 3: Implement** generator; `npm run gen:harness-codex`.
- [ ] **Step 4: Run** test + `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** —
      `feat(scripts): Codex harness package generated from the plugin sources`

### Task 14: Live test in Codex

> Carry-over from Task 13: verify that `$PWD` in the Codex SessionStart hook is
> the session directory (the SubagentStart script reads stdin `cwd` instead); if
> not, switch SessionStart to stdin `cwd` too. Also check `force-reindex`
> (mentions `run_in_background`) reads sensibly in Codex.

**Files:** `harness/codex/LIVE-TEST.md` (results), fixes in generator/skills as
found.

- [ ] **Step 1:** `npm run build` in the worktree (bare, no link).
- [ ] **Step 2:** Install into a scratch `CODEX_HOME` (never edit
      `~/.codex/config.toml` in place): copy `~/.codex/{auth.json,config.toml}`
      into `/tmp/codex-home-tr`, register the generated plugin through a local
      marketplace (`codex plugin marketplace add <harness/codex>` then
      `codex plugin add tea-rags@<marketplace>`, per README), switch its
      `.mcp.json` to the dev variant pointing at the worktree build, put
      `AGENTS.tea-rags.md` in the scratch `AGENTS.md`.
- [ ] **Step 3:** Run scripted checks with
      `CODEX_HOME=/tmp/codex-home-tr codex exec --json --ephemeral --dangerously-bypass-hook-trust -C /Users/artk0re/Dev/Tools/tea-rags-mcp "<prompt>"`
      (indexed alias `tea-rags`); assert on `item.completed` events of type
      `mcp_tool_call` (`server`, `tool`, `arguments`) and on shell items.
      Checks:
  1. "Quote the first heading of tea-rags://guide/navigation" → expect a
     `read_mcp_resource` call and `# ` heading text.
  2. "Where is registerAllResources defined? Show its body." → expect
     `find_symbol`, no shell `cat`/`rg` over `src/`.
  3. "What are this project's ruby/typescript signal thresholds?" → expect a
     read of `tea-rags://project/tea-rags/metrics…`.
  4. SessionStart: the session transcript shows the digest (hook output) before
     the first model turn.
  5. Skill trigger: "Use the bug-hunt skill: why does prime print an empty
     digest when Qdrant is down?" → skill loads, resource read happens.
- [ ] **Step 4:** Record each check (pass/fail, tool calls seen, tokens if
      reported) in `LIVE-TEST.md`; fix failures in generator/skills/core,
      regenerate, re-run the failed check.
- [ ] **Step 5:** Full eval run on Codex (user decision 2026-10-23). Runs after
      Tasks 17–19, against the root marketplace install (Codex:
      `codex plugin marketplace add <clone root>`; tea-rags + dinopowers +
      superpowers installed in the scratch `CODEX_HOME`). Same suites and cases
      as Task 12 (every `.claude-plugin/.benchmarks/<suite>` with runnable
      cases, ~620 + dinopowers), same `/optimize-skill` Phase 4 protocol: -
      Subject = Codex (`codex exec --json --ephemeral -C <repo>`, default Codex
      model, recorded per run): ONE run per suite, all case prompts in one
      prompt (id + prompt only), "describe the exact plan — skills (by `$name`),
      tools in order with key params, resources read; execute nothing". Hooks
      fire as installed (SessionStart digest, SubagentStart block) — this is the
      real Codex context, no bundle injection. - Skills are the generated Codex
      package (no load-time `!` blocks — the model-read lines must carry it);
      resource reads may be executed (`read_mcp_resource` against the worktree
      build) since they are reads. - Grader = Claude subagent (sonnet), strict
      against `expected` + `failure_mode`, mapping Claude tool names to Codex
      ones (`ReadMcpResourceTool` ≙ `read_mcp_resource`, `Skill(x)` ≙ `$x`,
      `mcp__tea-rags__t` ≙ `t`); expectations that are Claude-only mechanics
      (load-time inline, `AskUserQuestion`, `Agent` tool) graded on intent and
      flagged. - A/B vs the Task 12 Claude rows: every case that passes on
      Claude and fails on Codex is a Codex-harness regression → fix in
      `scripts/harness/transform.ts`, the Codex dialect, or the source text
      (never the eval), regenerate, re-run that suite only. - Persist:
      `## 2026-10-2x — Codex run (Task 14)` section per suite benchmark.md +
      summary in
      `.claude-plugin/.benchmarks/harness-context-economy/benchmark.md` (Codex
      vs Claude pass rate per suite, skills-list budget observed, model). -
      Budget: ≤ 3 parallel suites; codex runs consume the user's Codex quota
      (~45 runs) — approved 2026-10-23.
- [ ] **Step 6:** Commit —
      `test(scripts): Codex live test and full eval run of the generated harness`

### Task 15: Generate the Cursor package (no local Cursor — static validation)

Cursor is not installed on this machine, so there is no live test. The package
is validated against the published plugin spec and handed over with a manual
test script.

**Files:**

- Create: `scripts/gen-harness-cursor.ts` (shares the transform core
  `scripts/harness/transform.ts` with `gen-harness-codex.ts`; the dialect gains
  the resource tool names; skill selection, linked-file discovery and package
  formatting/writing move from the Codex generator into
  `scripts/harness/package.ts`)
- Create (generated): `harness/cursor/tea-rags/.cursor-plugin/plugin.json`,
  `harness/cursor/tea-rags/rules/tea-rags-core.mdc` (`alwaysApply: true`, core
  text), `harness/cursor/tea-rags/skills/<skill>/SKILL.md`,
  `harness/cursor/tea-rags/hooks/hooks.json`,
  `harness/cursor/tea-rags/mcp.json`,
  `harness/cursor/tea-rags/scripts/session-start.sh`, linked plugin files
  (`repair/`, and `rules/references/` relocated to `references/` with links
  rewritten, so `rules/` holds rule files only), `harness/cursor/README.md`,
  `harness/cursor/MANUAL-TEST.md`. The core rule is emitted only while
  `rules/core.md` exists (README says so otherwise).
- Test: `tests/scripts/gen-harness-cursor.test.ts` (drift guard +
  manifest/schema checks)

**Interfaces:**

- Consumes: the transform core from Task 13, `rules/core.md`.
- Produces:
  - `plugin.json`: `name: "tea-rags"`, `version` = tea-rags plugin version,
    `description`, `author`, `keywords` (default folders `rules/`, `skills/`,
    `hooks/hooks.json`, `mcp.json` are auto-discovered — facts §B.1).
  - `hooks/hooks.json`:
    `{ "version": 1, "hooks": { "sessionStart": [{ "command": "${CURSOR_PLUGIN_ROOT}/scripts/session-start.sh" }] } }`;
    the script prints `{ "additional_context": "<tea-rags prime output>" }`
    (sessionStart is fire-and-forget; the core's "no digest → …" line covers a
    missed delivery). No `subagentStart` / `preCompact` injection (Cursor cannot
    inject there).
  - `mcp.json`:
    `{ "mcpServers": { "tea-rags": { "type": "stdio", "command": "tea-rags", "args": ["server"] } } }`.
  - **Resources are unreliable in Cursor** (not documented; staff reported them
    partly disabled — facts §B.6). The core `.mdc` therefore names BOTH routes
    for every guide/metrics read: the resource URI, and the terminal fallback
    `tea-rags resource "<uri>" --path "$PWD"` (the CLI mirror, Task 3). Same
    substitution applies inside transformed skills.
  - Skill transform: Codex rules (no `$` mentions — Cursor uses `/skill-name`),
    `name` must equal the folder name; frontmatter `name`, `description`.

- [ ] **Step 1: Pin the facts in `harness/cursor/README.md`** — copy §B facts
      with sources from `docs/superpowers/specs/2026-10-23-harness-facts.md`;
      install path `~/.cursor/plugins/local/tea-rags` (second-hand — marked
      UNVERIFIED).
- [ ] **Step 2: Failing test** — drift guard; `plugin.json` has only spec
      fields; `.mdc` frontmatter has `alwaysApply: true`; core `.mdc` ≤ 4,096
      chars; every hook event is in Cursor's documented list.
- [ ] **Step 3: Implement** generator (+ shared transform extraction; Codex
      drift test must stay green).
- [ ] **Step 4: Write `MANUAL-TEST.md`** — the five Codex checks re-phrased for
      Cursor IDE and `cursor-agent -p --output-format json`, plus: resource read
      without `@` (`tea-rags://guide/navigation` first heading), `alwaysApply`
      rule reaching a subagent, sessionStart digest arrival.
- [ ] **Step 5: Run** tests + `npx tsc --noEmit` — PASS.
- [ ] **Step 6: Commit** —
      `feat(scripts): Cursor harness package generated from the plugin sources (manual test handed over)`

---

## Phase D2 — One source for every plugin package (spec Decision 11)

Runs after Task 12 (the eval runners read `.claude-plugin/**` paths) and before
Task 14, so the Codex live test installs from the final layout.

### Task 17: Move sources to `plugins/`; generate the Claude Code package

**Files:**

- Move: `.claude-plugin/{tea-rags,dinopowers,tea-rags-setup}/**` →
  `plugins/{tea-rags,dinopowers,tea-rags-setup}/**` (`git mv`, history kept).
  `.claude-plugin/.benchmarks/` stays (eval artifacts, not plugin content).
- Create: `scripts/gen-harness-claude.ts` — Claude dialect: verbatim copy of
  skills / rules / references / scripts (executable bits kept) + rendered
  `.claude-plugin/plugin.json`; `scripts/gen-plugins.ts` + `npm run gen:plugins`
  runs agent-context, Claude, Codex and Cursor generators in order.
- Modify: `scripts/gen-agent-context.ts`,
  `scripts/gen-harness-{codex,cursor}.ts`, `scripts/harness/package.ts` — read
  from `plugins/**`. (`scripts/gen-language-compatibility.ts` reads no plugin
  source — it splices `README.md` only — so it stays out of `gen:plugins`.)
- Create: root `.agents/plugins/marketplace.json` (marketplace `tea-rags`,
  replaces `harness/codex/.agents/`) and `.cursor-plugin/marketplace.json`, both
  generated, pointing at `harness/codex/*` / `harness/cursor/*`; root
  `.claude-plugin/marketplace.json` (hand-kept) keeps pointing at
  `.claude-plugin/<name>`.
- Modify: `tests/hooks/*.test.sh`, `tests/scripts/**` path constants; plugin
  version-bump hook (`check-plugin-version`) watches `plugins/<name>/**`.
- Test: `tests/scripts/gen-harness-claude.test.ts` — drift (render = committed),
  idempotent, executable bits, every hook command path resolves inside the
  package.

- [x] Steps: failing drift test → move → generator → `npm run gen:plugins` → all
      hook tests + `tests/scripts` green → install check (a test parses the
      three root manifests and resolves every `source` to a directory holding
      the harness's plugin manifest; `claude plugin marketplace add` is not run
      — it edits the user's global config) → commit.

### Task 18: Index exclusion, merge driver, release regeneration, workflow rule

**Files:**

- Modify: `.contextignore` — add `.claude-plugin/tea-rags/**`,
  `.claude-plugin/dinopowers/**`, `.claude-plugin/tea-rags-setup/**`,
  `harness/**` (sources under `plugins/**` stay indexed).
- Modify: `.gitattributes` — generated paths `merge=tea-rags-generated`.
- Create: `scripts/git/merge-generated.sh` — merge driver: take ours, mark the
  path for regeneration; `post-merge` / commit hook runs `npm run gen:plugins`
  and stages the result. `package.json` `prepare` registers
  `merge.tea-rags-generated.driver` in the clone's git config.
- Local command (source of truth for generation): `npm run gen:plugins` (Task
  17). Developers run it after editing `plugins/**` and may commit the output;
  CI never has its own generation logic, it only calls this script.
- Modify: `.releaserc.json` — release regenerates the packages (user decision
  2026-10-23): `@semantic-release/exec` `prepareCmd` becomes
  `bash scripts/prepare-changelog.sh && npm run gen:plugins`, and
  `@semantic-release/git` `assets` gain `.claude-plugin/**`, `.agents/**`,
  `.cursor-plugin/**`, `harness/**`, `src/mcp/resources/generated/**`. The
  packages land in the `chore(release)` commit next to the versions they carry,
  pushed with the existing `RELEASE_TOKEN` — no new secret, no bot workflow, no
  loop (release already skips `chore(release)` heads). `prepareCmd` runs after
  the version bump, so plugin manifests in the packages carry the released
  version.
- Drift tests become render tests (user decision 2026-10-23, option 2 — release
  owns regeneration): `tests/scripts/gen-harness-{claude,codex,cursor}.test.ts`
  and the agent-context drift test stop comparing the committed tree with a
  fresh render. They assert render properties instead: deterministic (render
  twice = same bytes), every relative link and hook path resolves, JSON parses,
  budgets hold, manifests resolve their `source`. The equality check moves into
  the release job after `npm run gen:plugins` (`git diff --stat` printed into
  the release log; the diff is what gets committed).
- Modify: `package.json` — `prebuild` runs `npm run gen:agent-context`:
  `src/mcp/resources/generated/agent-context.ts` is a compile input (server
  `instructions` + guides), and `release.yml` builds before semantic-release's
  `prepareCmd`, so without `prebuild` npm would publish a `build/` with a stale
  core. Same for `type-check` (`pretype-check`) so CI type-checks current text.
- No PR drift check: a PR that edits `plugins/**` without regenerating is valid
  — release regenerates. (A drift check would fail exactly those PRs.)
- Create: `.claude/rules/plugin-sources.md` — edit only `plugins/**`; regenerate
  with `npm run gen:plugins`; never hand-edit `.claude-plugin/<name>/**` or
  `harness/**`; version bumps go in `plugins/<name>/` manifest metadata.
- Test: `tests/hooks/merge-generated.test.sh` — two branches editing one source
  → merge has no conflict in generated paths and output equals a fresh
  regenerate.

- [ ] Steps: failing merge test → driver + hook → `.releaserc.json` (dry-run:
      `npx semantic-release --dry-run --no-ci` shows the prepare step) → rule →
      commit.

### Task 20: Guide prose leaves `registry.ts` — markdown templates with data placeholders

Single prose source for every agent-facing resource (user decision 2026-10-23).
Runs before Task 19 and the Codex eval run (Task 14 Step 5).

**Files:**

- Create:
  `plugins/tea-rags/rules/guides/{overview,presets,signals,filters,signal-labels,search-examples,indexing}.md`
  — the hand-written prose now inside `buildOverview`, `buildPresetsDoc`,
  `buildSignalsDoc`, `buildFiltersDoc`, `buildSignalLabelsGuide`,
  `buildSearchGuide`, `buildIndexingGuide`, `buildParamReference` (caveman
  ultra, meaning preserved). Every registry-derived block becomes a placeholder
  line `<!-- data:<key> -->` (e.g. `presets-table`, `signal-keys`,
  `filter-fields`, `label-thresholds-example`).
- Modify: `src/mcp/resources/registry.ts` — builders keep ONLY data rendering:
  `renderGuideData(key, app): string` per placeholder; a builder-backed guide =
  markdown template from `AGENT_CONTEXT_GUIDES[topic]` with every placeholder
  substituted. Builder-backed topics are excluded from the plain
  `AGENT_CONTEXT_GUIDES` loop (one registration per URI).
  `guide/language-capability`, `project/*`, `schema/*` aliases unchanged.
  Landed keys: `meta-only-contract` (overview), `presets-sections`,
  `signal-keys`, `git-fields` (filters), `label-tables` (signal-labels);
  search-examples and indexing are pure prose. Exported `build*` keep their
  signatures (barrel + `resources.test.ts` unchanged).
- Modify: `.prettierignore` — the seven templates (source + `.claude-plugin/`
  copy): Prettier's `proseWrap: always` reflow splits one-line examples the
  tests parse, puts a blank line under list leads, and escapes snake_case
  identifiers (`attr_*` → `attr*_`).
- Test: `tests/mcp/resources/guides.test.ts` — every placeholder in every
  template has a renderer and is substituted (no `<!-- data:` left in any read);
  unknown placeholder key → test failure; each guide URI registered once;
  listing ≤ 20; spot assertions that registry data (a preset name, a signal key,
  a filter field) still appears in the rendered guide.
- Regenerate: `npm run gen:plugins` (agent-context picks up the new guides;
  Codex / Cursor packages carry them where skills link them).

- [x] Steps: failing placeholder/registration tests → move prose (one guide per
      commit-sized step) → renderers → regenerate → all tests → commit.

### Task 19: dinopowers as its own Codex / Cursor plugin

Separate plugin next to tea-rags in both harness marketplaces (user decision
2026-10-23). Runs after Task 17 (generators read `plugins/**`), verified live in
Task 14.

**Files:**

- Modify: `scripts/gen-harness-{codex,cursor}.ts`, `scripts/harness/package.ts`
  — emit `harness/{codex,cursor}/dinopowers/` from `plugins/dinopowers/`; add it
  to both root marketplace manifests.
- Modify: `scripts/harness/transform.ts` — `Skill(superpowers:<s>)` becomes the
  harness mention of the superpowers skill, not a bare name; every wrapper gains
  a missing-dependency line: superpowers skill not available → stop and ask the
  user to install superpowers (link: https://github.com/obra/superpowers; Claude
  Code: `/plugin install superpowers@claude-plugins-official`; Codex / Cursor:
  the repository's own install steps), never run the wrapper's enrichment alone
  and present it as the full workflow.
- Modify: dinopowers SessionStart / SubagentStart routing scripts — Codex
  packages them like tea-rags' subagent block; Cursor gets sessionStart only.
- Test: `tests/scripts/gen-harness-{codex,cursor}.test.ts` — dinopowers package
  renders, idempotent, links resolve, superpowers mention + install line present
  in every wrapper.

**Open questions, answered by Task 14 (live Codex):**

1. Name collision — dinopowers wrappers share names with superpowers skills
   (`brainstorming`, `writing-plans`, …). Check whether Codex namespaces plugin
   skills; if not, ship wrappers as `dino-<name>`.
2. Skills-list budget — tea-rags 6,540 + dinopowers 5,366 (+ superpowers' own) ≈
   2× the ~8,000-char list budget. Measure what Codex drops; fixes in order:
   `allow_implicit_invocation: false` on internal tea-rags skills, shorter
   dinopowers descriptions for the Codex dialect, then a per-harness cap test.

## Phase E — Landing

### Task 16: Gates, docs, merge

> Carry-over from Task 13: `harness/**` duplicates skill markdown — exclude it
> from the tea-rags index (project ignore file) so search does not return
> generated copies.

- [ ] **Step 1:** Measure after-state with the round-1 scripts
      (`/Users/artk0re/.claude/jobs/ef10f65e/tmp/measure-mcp.mjs` adapted to the
      worktree build): inject bytes, prime bytes on taxdome + tea-rags, subagent
      block, frontmatter total, `instructions` length, `resources/list` count →
      `.claude-plugin/.benchmarks/harness-context-economy/benchmark.md`.
- [ ] **Step 2:** Docs — `README.md` / `website/` pages that describe prime,
      resources, rules injection (find via `hybrid_search` "tea-rags://schema" +
      "prime digest", `documentation: "only"`); add `tea-rags resource` CLI
      docs.
- [ ] **Step 3:** Merge `worktree-harness-context-economy` into `main`
      (`--no-ff`) after user authorization; `npm install && npm run build` on
      main (no link); `npm run test:coverage` once on main; fix findings as
      separate commits.
- [ ] **Step 4:** Live validation in Claude Code (user-gated: link + reconnect):
      SessionStart output size, `ReadMcpResourceTool` on `guide/navigation`, a
      subagent receives the alias line.
- [ ] **Step 5:** Close beads with evidence; remove the worktree per
      `worktree-beads-lifecycle.md`; push only on explicit user instruction.

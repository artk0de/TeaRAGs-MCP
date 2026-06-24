# Worktree-aware auto-reindex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (or dinopowers:subagent-driven-development) to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Chaining rule:
> invoke the `dinopowers:` wrapper, never the raw `superpowers:` skill.

**Goal:** Make incremental `index_codebase` run automatically at git-workflow
events (commit → worktree clone, merge → main) via an enforcement hook + skill
knowledge, so mid-task tea-rags searches see freshly-committed code.

**Architecture:** A `PostToolUse:Bash` hook resolves the commit directory to a
registered collection via a new `tea-rags project exist` CLI guard and runs an
incremental reindex (embeddings block ~1–3 s, enrichment detaches). The "when to
reindex" knowledge is encoded in the tea-rags canon (`index-freshness.md`) and
the dinopowers wrappers; wrapper SKILL.md edits go through `/optimize-skill`.

**Tech Stack:** TypeScript (CLI command, vitest), Bash (hook + plain-bash test
harness), Claude Code plugin manifests (JSON), Markdown (rules/skills).

**Spec:**
`docs/superpowers/specs/2026-06-24-worktree-aware-auto-reindex-design.md`

## Global Constraints

- Worktree-only: branch `worktree-maintenance-worktree-feature`. NEVER merge to
  main or push without an explicit user request.
- src/core change is limited to ONE new CLI command (`tea-rags project exist`);
  everything else is plugin files (`.claude-plugin/**`).
- `reindex_changes` is DEPRECATED — always use `index_codebase` (CLI:
  `tea-rags index-codebase`).
- The hook is a shell process with NO MCP access — it uses the CLI exclusively.
- Reindex execution model: `tea-rags index-codebase --json` WITHOUT
  `--wait-enrichments` (embeddings block, enrichment detaches). NEVER `--force`
  in the hook.
- Never lower coverage thresholds; never add `eslint-disable` or `v8 ignore`.
- Plugin commits use the plugin name as scope (`tea-rags` / `dinopowers`); the
  `check-release-scope.sh` warning for these is expected and non-blocking.
- CLI command name is exactly `tea-rags project exist` (singular `project`, verb
  `exist`, no trailing `s`) — a NEW top-level command, sibling to `projects`.
- The MCP server build/link and any live reindex are USER-GATED (Task 9 waits
  for explicit go-ahead).

---

## File Structure

- `src/cli/commands/project.ts` — NEW. The singular `project` command with one
  subcommand `exist`. One responsibility: answer "is this path/name a registered
  project?" and optionally print its alias.
- `src/cli/create-cli.ts` — MODIFY. Register the new `project` command.
- `tests/cli/commands/project.test.ts` — NEW. Unit tests for `project exist`.
- `.claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh` — NEW. The hook.
- `tests/hooks/reindex-on-git-commit.test.sh` — NEW. Plain-bash hook harness.
- `.claude-plugin/tea-rags/.claude-plugin/plugin.json` — MODIFY. Register hook +
  version bump.
- `.claude-plugin/tea-rags/rules/index-freshness.md` — MODIFY. Add trigger
  taxonomy.
- `.claude-plugin/dinopowers/FRESHNESS.md` — REWRITE. Commit-driven,
  `index_codebase`.
- `.claude-plugin/dinopowers/skills/{executing-plans,test-driven-development,finishing-a-development-branch}/SKILL.md`
  — MODIFY via `/optimize-skill`.
- `.claude-plugin/dinopowers/.claude-plugin/plugin.json` — MODIFY. Version bump.
- `.claude-plugin/.benchmarks/<skill>/{evals.json,benchmark.md}` — NEW per
  skill.

---

## Task 1: `tea-rags project exist` CLI guard

**Files:**

- Create: `src/cli/commands/project.ts`
- Modify: `src/cli/create-cli.ts`
- Test: `tests/cli/commands/project.test.ts`

**Interfaces:**

- Consumes: `CollectionRegistry` from `../../core/api/public/index.js`
  (`findByPath(absPath): CollectionEntry | undefined`; name lookup via
  `get(name)`). `resolveDataDir()` pattern =
  `process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags")`.
- Produces: CLI command `tea-rags project exist`. Contract:
  - `--path <p>` (resolved to absolute) OR `--name <n>` (mutually exclusive; at
    least one required).
  - exit code 0 if a registered project matches, exit 1 if not.
  - `--print-name`: on a match, print the project alias (`entry.name`) to stdout
    (nothing on no-match). With `--json`: print
    `{"exists":bool,"name":string|null}`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/commands/project.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "build", "cli", "index.js"); // built CLI entry

function runExist(
  args: string[],
  dataDir: string,
): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, "project", "exist", ...args], {
      env: { ...process.env, TEA_RAGS_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    return { code: 0, out: out.trim() };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout ?? "").toString().trim() };
  }
}

describe("tea-rags project exist", () => {
  let dataDir: string;
  let projectPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tr-data-"));
    projectPath = mkdtempSync(join(tmpdir(), "tr-proj-"));
    // Minimal registry.json with one entry keyed by projectPath.
    writeFileSync(
      join(dataDir, "registry.json"),
      JSON.stringify({
        version: 1,
        collections: {
          code_abc123: {
            collectionName: "code_abc123",
            path: projectPath,
            name: "demo",
          },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("exits 0 for a registered path", () => {
    expect(runExist(["--path", projectPath], dataDir).code).toBe(0);
  });

  it("exits 1 for an unregistered path", () => {
    expect(runExist(["--path", "/no/such/path"], dataDir).code).toBe(1);
  });

  it("prints the alias with --print-name on match", () => {
    const r = runExist(["--path", projectPath, "--print-name"], dataDir);
    expect(r.code).toBe(0);
    expect(r.out).toBe("demo");
  });

  it("prints nothing and exits 1 with --print-name on no match", () => {
    const r = runExist(["--path", "/no/such/path", "--print-name"], dataDir);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });

  it("resolves by --name", () => {
    expect(runExist(["--name", "demo"], dataDir).code).toBe(0);
    expect(runExist(["--name", "ghost"], dataDir).code).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/commands/project.test.ts` Expected: FAIL —
`project` command not registered (yargs unknown command / exit 1 everywhere).

- [ ] **Step 3: Write the command**

Mirror the construction in `src/cli/commands/projects.ts` (same
`CollectionRegistry` import from `../../core/api/public/index.js` and the
`resolveDataDir()` helper).

```ts
// src/cli/commands/project.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { CollectionRegistry } from "../../core/api/public/index.js";

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

interface ProjectExistArgs {
  path?: string;
  name?: string;
  printName?: boolean;
  json?: boolean;
}

const existCommand: CommandModule<object, ProjectExistArgs> = {
  command: "exist",
  describe:
    "Check whether a path or name is a registered tea-rags project (exit 0 = yes, 1 = no)",
  builder: (y) =>
    y
      .option("path", { type: "string", describe: "Project path to check" })
      .option("name", { type: "string", describe: "Project alias to check" })
      .option("print-name", {
        type: "boolean",
        default: false,
        describe: "Print the alias on match",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Emit {exists,name} as JSON",
      })
      .check((a) => {
        if (!a.path && !a.name) throw new Error("Provide --path or --name");
        return true;
      }),
  handler: (argv) => {
    const registry = new CollectionRegistry(
      join(resolveDataDir(), "registry.json"),
    );
    const entry = argv.path
      ? registry.findByPath(resolve(argv.path))
      : registry.get(argv.name!);
    const exists = Boolean(entry);
    if (argv.json) {
      process.stdout.write(
        JSON.stringify({ exists, name: entry?.name ?? null }) + "\n",
      );
    } else if (argv.printName && entry) {
      process.stdout.write(entry.name + "\n");
    }
    process.exit(exists ? 0 : 1);
  },
};

export const projectCommand: CommandModule = {
  command: "project",
  describe: "Query a single registered project (exist)",
  builder: (y) => y.command(existCommand).demandCommand(1),
  handler: () => {},
};
```

> Note: confirm `CollectionRegistry`'s constructor signature and `get()`
> accessor against `src/cli/commands/projects.ts` — if that file constructs the
> registry via a `RegistryFile` wrapper or a factory, use the identical
> construction here rather than `new CollectionRegistry(path)`. The behavior
> contract (findByPath / name lookup → exit code) is fixed; only the
> construction call adapts.

- [ ] **Step 4: Wire the command in create-cli.ts**

Add the import and `.command(projectCommand)` next to the existing
`projectsCommand` / `worktreeCommand` registrations in `src/cli/create-cli.ts`
(match the existing import order and registration style).

- [ ] **Step 5: Build + run test to verify it passes**

Run: `npm run build && npx vitest run tests/cli/commands/project.test.ts`
Expected: PASS (5/5).

- [ ] **Step 6: Type-check + lint**

Run: `npx tsc --noEmit && npx eslint src/cli/commands/project.ts` Expected: 0
errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/project.ts src/cli/create-cli.ts tests/cli/commands/project.test.ts
git commit -m "feat(cli): add 'project exist' guard command for registry membership

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Auto-reindex hook script

**Files:**

- Create: `.claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh`
- Test: `tests/hooks/reindex-on-git-commit.test.sh`

**Interfaces:**

- Consumes: PostToolUse payload on stdin (`.tool_name`, `.tool_input.command`,
  `.tool_output.stdout`/`.content`, `.cwd`); the `tea-rags project exist`
  command from Task 1; `tea-rags index-codebase`.
- Produces: a side effect only — an incremental reindex of the resolved
  collection, or a no-op. Exit code always 0 (a hook must not fail the tool).

- [ ] **Step 1: Write the failing test (plain-bash harness, no bats)**

```bash
# tests/hooks/reindex-on-git-commit.test.sh
#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

# Fake `tea-rags` on PATH: `project exist` reads $FAKE_REGISTERED, `index-codebase` records args.
FAKEBIN="$(mktemp -d)"; CALLS="$(mktemp)"
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "project exist")
    # registered if the --path value equals $FAKE_REGISTERED
    p=""; for a in "$@"; do [ "$prev" = "--path" ] && p="$a"; prev="$a"; done
    if [ -n "$FAKE_REGISTERED" ] && [ "$p" = "$FAKE_REGISTERED" ]; then
      echo "$FAKE_ALIAS"; exit 0
    fi
    exit 1 ;;
  "index-codebase "*|"index-codebase")
    echo "index-codebase $*" >> "$CALLS"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$FAKEBIN/tea-rags"
export PATH="$FAKEBIN:$PATH" CALLS

run() { # $1=json payload, $2=registered-path, $3=alias
  : > "$CALLS"; export FAKE_REGISTERED="$2" FAKE_ALIAS="$3"
  printf '%s' "$1" | bash "$HOOK" >/dev/null 2>&1
}
called() { grep -q -- "$1" "$CALLS"; }
empty()  { [ ! -s "$CALLS" ]; }

DIR="$(mktemp -d)"  # not a git repo → hook falls back to .cwd

# 1. successful commit in a registered dir → reindex by alias
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_output\":{\"stdout\":\"1 file changed\"}}" "$DIR" "demo"
called -- "--project demo"; note $? "commit in registered dir reindexes by alias"

# 2. unregistered dir → skip (no reindex)
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_output\":{\"stdout\":\"1 file changed\"}}" "" ""
empty; note $? "commit in unregistered dir skips reindex"

# 3. non-git Bash command → no-op
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"ls -la\"},\"tool_output\":{\"stdout\":\"\"}}" "$DIR" "demo"
empty; note $? "non-git command is a no-op"

# 4. failed commit (nothing to commit) → no-op
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_output\":{\"stdout\":\"nothing to commit, working tree clean\"}}" "$DIR" "demo"
empty; note $? "failed commit (nothing to commit) is a no-op"

# 5. successful merge in a registered dir → reindex
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git merge worktree-x\"},\"tool_output\":{\"stdout\":\"Fast-forward\"}}" "$DIR" "demo"
called -- "--project demo"; note $? "successful merge reindexes"

# 6. merge conflict → no-op
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git merge x\"},\"tool_output\":{\"stdout\":\"CONFLICT (content): Merge conflict in a.ts\"}}" "$DIR" "demo"
empty; note $? "merge conflict is a no-op"

# 7. non-Bash tool → no-op
run "{\"tool_name\":\"Edit\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit\"},\"tool_output\":{\"stdout\":\"\"}}" "$DIR" "demo"
empty; note $? "non-Bash tool is a no-op"

rm -rf "$FAKEBIN" "$DIR" "$CALLS"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/hooks/reindex-on-git-commit.test.sh` Expected: FAIL — hook
script does not exist yet (`bash: .../reindex-on-git-commit.sh: No such file`).

- [ ] **Step 3: Write the hook**

```bash
#!/usr/bin/env bash
# PostToolUse hook: incremental reindex after a successful git commit / merge.
# Reads the PostToolUse payload from stdin. Resolves the commit directory to a
# registered tea-rags collection and runs an incremental `index_codebase`
# (embeddings block ~1-3s, enrichment detaches) so mid-task searches see
# freshly-committed code. Skips silently when the directory is not a registered
# project (e.g. a bare git worktree with no clone) — never creates a stray
# collection. A hook must never fail the tool: always exit 0.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
echo "$COMMAND" | grep -qE '(^|&&|;|\|)[[:space:]]*git[[:space:]]+(commit|merge)' || exit 0

TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // .tool_output.content // empty')
if echo "$TOOL_OUTPUT" | grep -qiE 'nothing to commit|no changes added|CONFLICT|Merge conflict|Automatic merge failed|not something we can merge'; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -n "$CWD" ] || CWD="$PWD"
DIR=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")

ALIAS=$(tea-rags project exist --path "$DIR" --print-name 2>/dev/null) || {
  echo "[reindex-on-git-commit] $DIR not a registered tea-rags project — skipping" >&2
  exit 0
}
[ -n "$ALIAS" ] || exit 0

# Incremental reindex: embeddings block (~1-3s), enrichment detaches (no --wait-enrichments, no --force).
tea-rags index-codebase --project "$ALIAS" --json >/dev/null 2>&1
exit 0
```

- [ ] **Step 4: Make executable + run test to verify it passes**

Run:
`chmod +x .claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh && bash tests/hooks/reindex-on-git-commit.test.sh`
Expected: `PASS=7 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh tests/hooks/reindex-on-git-commit.test.sh
git commit -m "feat(tea-rags): post-commit/merge auto-reindex hook script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Register the hook + bump tea-rags plugin version

**Files:**

- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json`

- [ ] **Step 1: Add the PostToolUse[Bash] entry (additive — leave existing hooks
      untouched)**

Inside the existing `"hooks"` object, add a `PostToolUse` array (or append to it
if one exists):

```json
"PostToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/reindex-on-git-commit.sh",
        "timeout": 120
      }
    ]
  }
]
```

- [ ] **Step 2: Bump version `0.27.0` → `0.28.0`** in the same file.

- [ ] **Step 3: Validate JSON + hook entry present**

Run:

```bash
jq -e '.version=="0.28.0" and (.hooks.PostToolUse[] | .hooks[] | select(.command|test("reindex-on-git-commit")))' .claude-plugin/tea-rags/.claude-plugin/plugin.json
```

Expected: prints `true`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "feat(tea-rags): register post-commit auto-reindex hook (v0.28.0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: tea-rags canon — trigger taxonomy

**Files:**

- Modify: `.claude-plugin/tea-rags/rules/index-freshness.md`

- [ ] **Step 1: Add a "Git-workflow auto-reindex triggers" section** with the
      taxonomy table from the spec (verbatim values):

```markdown
## Git-workflow auto-reindex triggers

A `PostToolUse:Bash` hook reindexes automatically at these events — no manual
checklist. The trigger is git events, not per-edit (a commit is the checkpoint;
the incremental diff is exactly the committed change).

| Event                                                  | Action                            | Target                        | Gate                         |
| ------------------------------------------------------ | --------------------------------- | ----------------------------- | ---------------------------- |
| Commit on a worktree branch (plain or subagent-driven) | `index_codebase` incremental      | worktree clone (cwd-resolved) | auto — clone is throwaway    |
| Merge into `main`                                      | `index_codebase` incremental      | `main`                        | the merge act IS the gate    |
| Branch finished (post-merge)                           | `tea-rags worktree remove <name>` | clone footprint dropped       | skill-only (not a git event) |
| Edited-but-uncommitted before a search                 | manual `index_codebase`           | current collection            | commit boundary is primary   |
| Schema drift                                           | `force_reindex`                   | —                             | explicit consent (unchanged) |

The hook resolves the collection via
`tea-rags project exist --path <dir> --print-name` and skips a directory that is
not a registered project (bare worktree, no clone). Commits made inside
subagents and bare sessions are covered by the hook, since it is tool-level —
not dependent on any wrapper being active.
```

- [ ] **Step 2: Validate markdown**

Run: `npx markdownlint-cli2 .claude-plugin/tea-rags/rules/index-freshness.md`
(or the repo's configured markdown lint). Fix any reported issues.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/tea-rags/rules/index-freshness.md
git commit -m "docs(tea-rags): add git-workflow auto-reindex trigger taxonomy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Rewrite dinopowers FRESHNESS.md + deprecation sweep

**Files:**

- Modify: `.claude-plugin/dinopowers/FRESHNESS.md`
- Sweep: any `.claude-plugin/**` file still referencing `reindex_changes`

- [ ] **Step 1: Rewrite FRESHNESS.md** to: (a) point at the hook as the primary
      mechanism, (b) use `index_codebase` not `reindex_changes`, (c) defer the
      trigger taxonomy to `tea-rags/rules/index-freshness.md` (single source of
      truth), (d) keep ONLY the manual escape hatch for searching uncommitted
      WIP:

```markdown
# dinopowers Index Freshness Protocol

Index freshness is now enforced by a `PostToolUse:Bash` hook
(`tea-rags/scripts/reindex-on-git-commit.sh`) that runs an incremental
`index_codebase` after every successful `git commit` / `git merge`, targeting
the collection resolved from the commit directory. The canonical trigger
taxonomy lives in `tea-rags/rules/index-freshness.md`.

## What wrappers must still do

- **Searching uncommitted WIP** — the hook fires on commit, not on edit. If you
  must search code you have edited but not yet committed, run `index_codebase`
  (incremental) manually first, then search. Otherwise rely on the commit
  boundary.
- **NEVER call the deprecated `reindex_changes`** — always `index_codebase`.
- **Do not force-reindex** — `force_reindex` is for schema drift only and needs
  explicit user consent.
```

- [ ] **Step 2: Deprecation sweep — find any remaining `reindex_changes`**

Run: `grep -rn "reindex_changes" .claude-plugin/ || echo "clean"` Replace every
hit (FRESHNESS.md references in other wrapper SKILL.md files, rules) with
`index_codebase`. Re-run until it prints `clean`.

- [ ] **Step 3: Validate markdown + commit**

```bash
npx markdownlint-cli2 .claude-plugin/dinopowers/FRESHNESS.md
git add -A .claude-plugin/
git commit -m "docs(dinopowers): rewrite FRESHNESS for hook-driven index_codebase; drop reindex_changes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: optimize-skill — dinopowers:executing-plans

**Files:**

- Modify: `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md` (via
  `/optimize-skill`)
- Create:
  `.claude-plugin/.benchmarks/dinopowers-executing-plans/{evals.json,benchmark.md}`

**Content to add** (the freshness guidance the eval must prove changes
behavior):

> After committing a task, the `PostToolUse` hook reindexes the worktree
> automatically — no manual reindex needed between tasks. To search code you
> have edited but NOT yet committed, run `index_codebase` (incremental) manually
> first. Never call the deprecated `reindex_changes`.

- [ ] **Step 1: Invoke `/optimize-skill` on the skill**

Invoke the `optimize-skill` Skill with arg
`.claude-plugin/dinopowers/skills/executing-plans/SKILL.md`. Run its full cycle:
Phase 1 audit → Phase 2 baseline eval (with/without the new freshness guidance,
including ≥2 subagent-context cases) → Phase 3 apply the content above → Phase 4
verify to 100% with-rule pass → Phase 6 PERSIST.

- [ ] **Step 2: Verify benchmark target**

With-rule pass rate = 100%; delta over baseline ≥ +50pp on the
freshness-specific cases. If < +50pp, iterate (Phase 5, max 3).

- [ ] **Step 3: Commit (skill + benchmarks)**

```bash
git add .claude-plugin/dinopowers/skills/executing-plans/SKILL.md .claude-plugin/.benchmarks/dinopowers-executing-plans/
git commit -m "feat(dinopowers): executing-plans surfaces post-commit auto-reindex (eval-verified)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: optimize-skill — dinopowers:test-driven-development

**Files:**

- Modify: `.claude-plugin/dinopowers/skills/test-driven-development/SKILL.md`
  (via `/optimize-skill`)
- Create:
  `.claude-plugin/.benchmarks/dinopowers-test-driven-development/{evals.json,benchmark.md}`

**Content to add** (same intent, TDD-phrased):

> After each RED→GREEN commit, the `PostToolUse` hook reindexes the worktree —
> the next test/impl search sees the just-committed code. To search uncommitted
> WIP (a failing test you have not committed), run `index_codebase` manually.
> Never call the deprecated `reindex_changes`.

- [ ] **Step 1: Invoke `/optimize-skill`** on the skill — full cycle (audit →
      baseline → fix → verify 100% → persist), ≥2 subagent-context cases.

- [ ] **Step 2: Verify** with-rule 100%, delta ≥ +50pp on freshness cases.

- [ ] **Step 3: Commit (skill + benchmarks)**

```bash
git add .claude-plugin/dinopowers/skills/test-driven-development/SKILL.md .claude-plugin/.benchmarks/dinopowers-test-driven-development/
git commit -m "feat(dinopowers): test-driven-development surfaces post-commit auto-reindex (eval-verified)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: optimize-skill — dinopowers:finishing-a-development-branch + dinopowers version bump

**Files:**

- Modify:
  `.claude-plugin/dinopowers/skills/finishing-a-development-branch/SKILL.md`
  (via `/optimize-skill`)
- Modify: `.claude-plugin/dinopowers/.claude-plugin/plugin.json` (version bump)
- Create:
  `.claude-plugin/.benchmarks/dinopowers-finishing-a-development-branch/{evals.json,benchmark.md}`

**Content to add** (merge orchestration + cleanup):

> When finishing a worktree branch: after the merge to `main` succeeds, the
> `PostToolUse` hook reindexes `main` automatically. Then drop the per-worktree
> index clone with `tea-rags worktree remove <name>` — the clone is throwaway
> and its footprint (Qdrant + DuckDB + snapshots) should not linger. Never call
> the deprecated `reindex_changes`.

- [ ] **Step 1: Invoke `/optimize-skill`** on the skill — full cycle, ≥2
      subagent-context cases. The eval must prove the agent (a) does NOT
      manually reindex main (hook covers it) and (b) DOES run
      `tea-rags worktree remove` on finish.

- [ ] **Step 2: Verify** with-rule 100%, delta ≥ +50pp.

- [ ] **Step 3: Bump dinopowers version `0.18.0` → `0.19.0`** in
      `.claude-plugin/dinopowers/.claude-plugin/plugin.json`.

- [ ] **Step 4: Commit (skill + benchmarks + version)**

```bash
git add .claude-plugin/dinopowers/skills/finishing-a-development-branch/SKILL.md \
        .claude-plugin/.benchmarks/dinopowers-finishing-a-development-branch/ \
        .claude-plugin/dinopowers/.claude-plugin/plugin.json
git commit -m "feat(dinopowers): finishing-a-development-branch reindexes main + removes clone (v0.19.0, eval-verified)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Validation

**Files:** none (verification only)

- [ ] **Step 1: Full unit suites green**

Run:
`npx vitest run tests/cli/commands/project.test.ts && bash tests/hooks/reindex-on-git-commit.test.sh`
Expected: vitest 5/5 PASS; hook harness `PASS=7 FAIL=0`.

- [ ] **Step 2: Type-check + lint clean**

Run: `npx tsc --noEmit && npx eslint src/cli/commands/project.ts` Expected: 0
errors.

- [ ] **Step 3: Benchmarks persisted**

Run:
`ls .claude-plugin/.benchmarks/dinopowers-{executing-plans,test-driven-development,finishing-a-development-branch}/benchmark.md`
Expected: all three exist. Each reports with-rule 100% and delta ≥ +50pp.

- [ ] **Step 4: Deprecation sweep clean**

Run: `grep -rn "reindex_changes" .claude-plugin/ || echo clean` Expected:
`clean`.

- [ ] **Step 5: Live smoke (USER-GATED — wait for explicit go-ahead)**

This requires building + linking the worktree's CLI so the hook calls the new
`project exist` command, then reconnecting MCP. Do NOT run without an explicit
request. When authorized:

1. `npm run build && npm link` (worktree build).
2. Make a trivial commit on this worktree branch.
3. Confirm via `mcp__tea-rags__get_index_status` (or `tea-rags projects info`)
   that the resolved collection's `indexedAt` advanced — i.e. the hook reindexed
   the right collection (the worktree clone if one exists, else `main`).

---

## Self-Review

- **Spec coverage:** Component 1 (hook) → Tasks 2-3; Component 1
  collection-resolve guard → Task 1 (`project exist`, added per user decision);
  Component 2 canon → Task 4; Component 2 FRESHNESS → Task 5; Component 2
  wrappers via optimize-skill → Tasks 6-8; Component 3 deprecation sweep → Task
  5 + Task 9 Step 4; Versioning → Tasks 3 & 8; Testing/validation → Tasks 1,2,9.
  All spec sections mapped.
- **Type consistency:** `tea-rags project exist --path/--name/--print-name`
  (Task 1) is the exact command the hook calls (Task 2). `index_codebase`
  everywhere (no `reindex_changes`). Alias = `entry.name` consistently.
- **Scope:** single implementation plan; deliverable B explicitly out of scope.

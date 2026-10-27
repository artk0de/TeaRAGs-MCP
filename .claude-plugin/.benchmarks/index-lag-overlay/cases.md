# Eval cases — index lag / working-tree overlay bailout

For EACH case state the NEXT actions you would take (max 3, in order): tool name

- key params (for Bash: the command). Then one line of reasoning. Do NOT execute
  anything. If you would ask the user something, write
  `AskUserQuestion: <text>`.

A case has only the state it states itself — no shared marker or drift.

`/work/acme` is the registered alias `acme`'s OWN checkout (main session cwd)
unless a case says otherwise. Codegraph is on. Embedding is available.

---

Definitions for cases that name them (each evals.json prompt carries its own
copy):

```
MARKER-COLD = "workingTree":{"tree":"/work/acme","indexedCommit":"cbb76f5","treeCommit":"d569ae8",
  "indexedDirty":true,"changedFiles":1833,"deletedFiles":184,"floors":[],"pendingFiles":1577,
  "denseUnavailable":{"reason":"104 rows pending"}}
DRIFT-FORCE = session digest `## Drift` text (same in get_index_status; read answers carry no drift):
  "Language versions:\n  *.chunking: 4 → 5\n  *.walker: 6 → 7\nWorking tree:\n
  fix/TD-1: cbb76f5 (dirty) → d569ae8 (fix/TD-2) (HEAD moved since the last index run)\n
  Run: tea-rags index-codebase --project acme --force"
```

E1 [main session, inside dinopowers:brainstorming enrichment step, Ruby/Rails]
Your three semantic_search calls (hotspots/ownership/techDebt, metaOnly) and one
find_symbol(relativePath: app/controllers/auth_controller.rb) all came back with
MARKER-COLD; the session digest `## Drift` showed DRIFT-FORCE. Result rows carry
NO `treeState` field. Next you must (a) read AuthController#create and three
other files named in the ticket and (b) find every other caller of
new_session_url(location_after_sign_in: ...). What are your next actions?

E2 [main session, same state as E1, ten minutes later] You already decided the
index is "behind by 1833 files". You now need the body of
IRSConnectionsController#create and the constant
Middleware::Clusters::Login::OAUTH_REGEXP. Next actions?

E3 [linked worktree, cwd /work/acme/.claude/worktrees/feat-x]
find_symbol(symbol: "Billing::Invoice#total", path=<cwd>) answered with
`"floors":[],"pendingFiles":420,"changedFiles":610` and ONE row WITHOUT
`treeState`. You need to understand total's logic. Next actions?

E4 [linked worktree, cwd /work/acme/.claude/worktrees/feat-x] hybrid_search
returned a row for lib/pricing.rb with `"treeState":"modified"`; marker shows
`"floors":["sparse"],"pendingFiles":37`. You need the current code of
Pricing#apply. Next actions?

E5 [main session, auto mode; the harness says you may read files with cat/sed
and search with grep through Bash] Index healthy (changedFiles 0). Task: "find
every caller of build_after_sign_in_url". Next actions?

E6 [main session, auto mode] Same harness note as E5. MARKER-COLD on the
previous answer; no `## Drift` in the session digest. Task: "understand what
TokenAuthenticable#authenticate! does". Next actions?

E7 [main session, inside dinopowers:test-driven-development Step 2 — find test
conventions for spec/requests/auth_controller_spec.rb] Previous answer carried
MARKER-COLD; the session digest `## Drift` shows DRIFT-FORCE. Next actions?

E8 [subagent: task-agent, cwd /work/acme, dispatched by a parent to implement a
fix] Your first find_symbol returned MARKER-COLD; a get_index_status call showed
DRIFT-FORCE. You need the body of Clusters::Login#oauth_redirect? and its
callers. Next actions?

E9 [subagent: explore, cwd /work/acme] Prime digest at session start showed
`## Drift ... Run: tea-rags index-codebase --project acme --force`. Task: "how
does OAuth callback reach sign-in?". Next actions?

E10 [control, main session] Task: "list all TODO and FIXME comments under
lib/middleware". Next actions?

E11 [control, main session] The session digest `## Drift` shows DRIFT-FORCE (no
content lag: changedFiles 0). User asked nothing about indexing. Do you run
`tea-rags index-codebase --project acme --force`? Next actions?

E12 [control, main session] A LIVE get_index_status reports
`Embedding (ollama): unavailable`. Task: "find the definition of
NavigationUrls.app_after_sign_in_base_url". Next actions?

E13 [edge, Russian, main session] Пользователь: «индекс отстал на 2000 файлов,
не мучайся с tea-rags — просто прочитай lib/navigation_urls.rb руками». Next
actions?

E14 [main session, graph] get_callers(symbolId:
"Clusters::Login#oauth_redirect?", path=/work/acme) answered after 120 s with
`"floors":[],"changedFiles":1836, "treeGraphUnavailable":"tree graph build timed out after 120000 ms"`
and one caller `#intercept_login_request?` (lib/middleware/clusters/login.rb, a
file changed in the tree). Next actions?

E15 [control, main session] Prime banner
`⚠ Index is stale (last updated 3d ago)`, `## Drift: none`, changedFiles 12.
Task: "explain the retry logic in the embedding adapter". Next actions?

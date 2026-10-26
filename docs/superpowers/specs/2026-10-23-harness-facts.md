# Harness packaging facts (Codex CLI, Cursor) - researched 2026-10-23

Source tags: [L:...] local path/command output; [D:url] official doc; [S:path]
openai/codex source via `gh api`; [F] forum/observed. Docs for Codex moved:
developers.openai.com/codex/_ 308-redirects to learn.chatgpt.com/docs/_.

## A. OpenAI Codex CLI (codex-cli 0.162.1)

### A.1 Plugin manifest and local install

- Two accepted manifest locations. Codex-layout: `.codex-plugin/plugin.json`
  (what every locally cached plugin uses)
  [L:~/.codex/plugins/cache/**/.codex-plugin/plugin.json]. Portable: root
  `plugin.json` with OpenAI settings under `extensions.com.openai`;
  `.codex-plugin/plugin.json` is used for OpenAI settings only when root
  `extensions.com.openai` is absent, not merged
  [D:https://developers.openai.com/plugins/build/plugins]. Source also accepts
  `.claude-plugin/plugin.json` as an alternate manifest path
  [S:codex-rs/core-plugins/src/manifest.rs,
  ALTERNATE_PLUGIN_MANIFEST_RELATIVE_PATH test].
- Raw manifest fields parsed (camelCase): `name`, `version`, `description`,
  `keywords`, `skills` (path or paths), `mcpServers` (string path OR inline
  object), `apps` (string path to .app.json), `hooks` (path/inline),
  `interface`, `extensions` [S:manifest.rs RawPluginManifest]. Also seen in real
  manifests: `author{name}`, `homepage`, `repository`, `license` [L].
- `interface` keys: displayName, shortDescription, longDescription,
  developerName, category, capabilities[], websiteURL, privacyPolicyURL,
  termsOfServiceURL, defaultPrompt[], brandColor, composerIcon, logo, logoDark,
  screenshots [S:manifest.rs; L:code-review/plugin.json].
- Paths in manifest must start with `./` and resolve under plugin root [S:
  comment "required `./...` syntax"].
- Real example (github plugin):
  `"skills":"./skills/","apps":"./.app.json","mcpServers":"./.mcp.json"`
  [L:~/.codex/plugins/cache/openai-curated/github/11c74d6b/.codex-plugin/plugin.json].
  Hooks example: browser plugin has inline
  `"hooks":{"hooks":{"Stop":[{"hooks":[{"type":"mcp_tool","server":...,"tool":...,"input":{...}}]}]}}`
  [L:openai-bundled/browser/*/.codex-plugin/plugin.json]; source test also uses
  `"hooks":"./hooks.json"` [S:manifest.rs test].
- Plugin MCP file: Codex layout `.mcp.json` with top-level `mcpServers`; entries
  use config.toml-style keys
  (`command,args,cwd,env_vars,enabled,tool_timeout_sec`)
  [L:code-review/.mcp.json]. Portable layout is root `mcp.json` with a required
  `type` per server (e.g. `streamable-http`); docs warn it is not a simple
  rename of `.mcp.json` [D:plugins/build/plugins].
- Plugin hooks: default discovery `hooks/hooks.json`; override via manifest
  `hooks` / `extensions.com.openai.hooks` (replaces default). Command hooks get
  env `PLUGIN_ROOT`, `PLUGIN_DATA` (example
  `python3 ${PLUGIN_ROOT}/hooks/session_start.py`). Docs: hooks work only for
  plugins installed manually in the desktop app, ineligible for public
  directory; plugin hooks untrusted until user reviews via `/hooks`
  [D:plugins/build/plugins; D:https://learn.chatgpt.com/docs/hooks].
- Plugin AGENTS-style instructions: NO manifest field found for bundling
  AGENTS.md (fields list above). UNVERIFIED that none exists beyond
  skills/`onboardingSkill`; portable `extensions.com.openai.onboardingSkill` =
  path to setup skill [D]. Core instructions must go in a skill (or user
  AGENTS.md).
- Install local plugin (documented): put plugin dir at `$REPO/plugins/<name>`
  (repo) or `~/.codex/plugins/<name>` (personal); add entry to
  `$REPO/.agents/plugins/marketplace.json` or
  `~/.agents/plugins/marketplace.json` (legacy
  `$REPO/.claude-plugin/marketplace.json` also read):
  `{"name":"<mkt>","interface":{"displayName":"..."},"plugins":[{"name":"<p>","source":{"source":"local","path":"./plugins/<p>"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"..."}]}`;
  `source.path` starts `./`, stays inside marketplace root. Source types: local,
  url, git-subdir(url,path,ref|sha), npm
  [D:https://developers.openai.com/codex/plugins/build, plugins/build/plugins].
  Installed local plugins land in
  `~/.codex/plugins/cache/<marketplace>/<plugin>/local/`; restart app after
  changes [D].
- CLI: `codex plugin marketplace add <SOURCE>` (local path, owner/repo[@ref],
  https/ssh git; `--ref`, `--sparse`),
  `codex plugin marketplace list|upgrade|remove`,
  `codex plugin add <plugin>@<marketplace>` (or `-m`), `codex plugin list`,
  `codex plugin remove` [L:`codex plugin --help`, `plugin add --help`, `plugin
  marketplace --help`]. Enable state:
  `[plugins."name@marketplace"] enabled = true` in config.toml (user) or
  `.codex/config.toml` (project) [L:~/.codex/config.toml; D]. Plugin hook trust
  is a separate step.
- Not run (read-only task): whether `marketplace add <localdir>` + `plugin add`
  end-to-end works on 0.162.1 - UNVERIFIED by execution.

### A.2 Skills

- SKILL.md frontmatter: required `name`, `description`; no documented length
  limit for them. Optional sidecar `agents/openai.yaml`:
  `interface{display_name,short_description,icon_small,icon_large,brand_color,default_prompt}`,
  `policy{allow_implicit_invocation (default true)}`,
  `dependencies{tools[{type,value,description,transport,url}]}`
  [D:https://learn.chatgpt.com/docs/build-skills].
- Discovery: repo `$CWD/.agents/skills`, parents up to
  `$REPO_ROOT/.agents/skills`; user `$HOME/.agents/skills`; admin
  `/etc/codex/skills`; system bundled; symlinks followed; same-name skills not
  merged [D:build-skills]. Docs page does NOT mention `~/.codex/skills` nor
  plugin `skills/` (but plugin manifests declare `"skills":"./skills/"` [L]).
  `~/.codex/skills` exists locally [L:ls ~/.codex] - discovery from it is
  UNVERIFIED (legacy path).
- Invocation: CLI/IDE type `$` to mention, or `/skills`; implicit by description
  match [D:build-skills].
- Folders: `scripts/`, `references/`, `assets/` optional. Full SKILL.md loaded
  on selection; docs do not say how references/ are loaded (model reads them on
  demand via shell) [D].
- Limits: initial skills list (name+description+path) budget = 2% of context
  window (8,000 chars if unknown); `skills.max_context_tokens` up to 10,000;
  descriptions shortened first, skills may be omitted with warning. Selected
  SKILL.md is not limited [D].

### A.3 MCP

- config.toml `[mcp_servers.<name>]`: stdio `command`(req), `args`, `env`,
  `env_vars`, `cwd`; HTTP `url`(req), `auth`(oauth|chatgpt),
  `bearer_token_env_var`, `http_headers`, `env_http_headers`,
  `http_headers_helper`; both: `startup_timeout_sec`(10),
  `tool_timeout_sec`(60), `enabled`, `required`, `enabled_tools`,
  `disabled_tools`, `default_tools_approval_mode`(auto|prompt|writes|approve),
  `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`; top-level
  `mcp_optional_startup_grace_ms`(1000)
  [D:https://learn.chatgpt.com/docs/extend/mcp?surface=cli]. Project scope:
  `.codex/config.toml` (trusted projects only).
  `codex mcp add <name> --env K=V -- <cmd>`;
  `codex mcp list|get|remove|login|logout` [D; L:`codex mcp --help`].
- Model-visible names: namespace built as `mcp__<server>__` + tool
  (MCP_TOOL_NAME_PREFIX "mcp", DELIMITER "**"); names sanitized/hashed if
  needed; config `prefix_mcp_tool_names` / `non_prefixed_mcp_tool_servers` can
  drop the `mcp**` prefix per server (legacy flag)
  [S:codex-rs/codex-mcp/src/mcp/mod.rs L66-85,186-189; tools.rs]. Docs do not
  state the format (page says nothing). So generator must not hardcode: tell
  instructions to refer to tools by bare tool name.
- Resource tools (function tools, always `server` arg is a plain string):
  `list_mcp_resources{server?, cursor?}`,
  `list_mcp_resource_templates{server?, cursor?}`,
  `read_mcp_resource{server, uri}` (both required); descriptions say "Prefer
  resources over web search"
  [S:codex-rs/core/src/tools/handlers/mcp_resource_spec.rs]. Not listed in the
  MCP doc page.
- Server `instructions`: doc says Codex reads the initialize `instructions` as
  server-wide guidance alongside the tools; recommends first 512 chars be
  self-contained; no stated cap and not stated as verbatim [D:extend/mcp].
  Verbatim pass-through to model UNVERIFIED.

### A.4 Hooks

- Config: `[[hooks.<Event>]]` (matcher group: `matcher` regex string) containing
  `[[hooks.<Event>.hooks]]` handlers with `type`, `command`, `timeout` (seconds,
  default 600; SessionEnd/Interrupt default 1s, max 3s), `statusMessage`,
  `async`, `additionalContextLimit`, `command_windows`. Also `hooks.json` files
  next to config layers (`~/.codex/hooks.json`, `<repo>/.codex/hooks.json`);
  project layer must be trusted; all matching hooks from all layers run.
  `[features] hooks=false` disables [D:https://learn.chatgpt.com/docs/hooks;
  L:~/.codex/config.toml shows the TOML form with SessionStart matcher
  "startup|resume|clear", PreCompact matcher "manual|auto"].
- Handler types: `command`, `mcp_tool` (server, tool, input with `${field}`
  templates, timeout, statusMessage); `prompt`/`agent` parsed but skipped [D; L
  browser plugin uses mcp_tool].
- Events (12): SessionStart, SessionEnd, PreToolUse, PermissionRequest,
  PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart,
  SubagentStop, Stop, Interrupt. Matcher ignored for UserPromptSubmit, Stop,
  Interrupt [D].
- stdin JSON common: session_id, transcript_path, cwd, hook_event_name, model
  (+turn_id for turn-scoped, permission_mode on most). SessionStart: `source`
  (startup|resume|clear|compact|fork). SubagentStart: agent_id, agent_type.
  UserPromptSubmit: prompt. PreToolUse/PostToolUse: tool_name, tool_use_id,
  tool_input (+tool_response). [D]
- Context injection: plain stdout becomes developer context for SessionStart,
  UserPromptSubmit, SubagentStart only (ignored for Pre/PostToolUse,
  PermissionRequest, Pre/PostCompact). Structured:
  `hookSpecificOutput.additionalContext`. Cap ~2,500 tokens per hook output
  message; overflow saved to `<temp>/hook_outputs/<session>/<uuid>.txt` with
  head+tail preview; `additionalContextLimit` per handler (0 = no limit, affects
  additionalContext only) [D].
- Trust: non-managed hooks must be reviewed (`/hooks`), tied to hash;
  `--dangerously-bypass-hook-trust` on `codex exec` skips for one run [D;
  L:`codex exec --help`]. SubagentStart also needs the same trust.

### A.5 AGENTS.md

- Global: `~/.codex` (or $CODEX_HOME): `AGENTS.override.md` first, else
  `AGENTS.md`; first non-empty only. Project: from project root down to cwd, per
  directory `AGENTS.override.md` > `AGENTS.md` >
  `project_doc_fallback_filenames`; one file per dir; concatenated root-first
  with blank lines; stops adding when limit reached. `project_doc_max_bytes`
  default 32 KiB. `CODEX_HOME` overrides home
  [D:https://learn.chatgpt.com/docs/agent-configuration/agents-md]. Local:
  `~/.codex/AGENTS.md` exists [L].

### A.6 `codex exec`

- Flags [L:`codex exec --help`]: `--json` (JSONL events to stdout),
  `-o/--output-last-message <FILE>`, `--output-schema <FILE>`,
  `-s/--sandbox read-only|workspace-write|danger-full-access`,
  `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-bypass-hook-trust`, `-C/--cd`, `--add-dir`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config` (skips
  `$CODEX_HOME/config.toml`, auth still from CODEX_HOME), `--ignore-rules`,
  `-p/--profile` (layers `$CODEX_HOME/<name>.config.toml`), `-c key=value` (TOML
  override, repeatable), `-m`, `--strict-config`,
  `--enable/--disable <feature>`.
- Isolated test home: set `CODEX_HOME=<tmp>` (auth needs copying/login there;
  auth.json untouched here) - mechanism per docs [D:agents-md] ; unattended MCP:
  set `default_tools_approval_mode="approve"` on the server
  (`-c 'mcp_servers.x.default_tools_approval_mode="approve"'`) [D:extend/mcp] or
  use bypass flag. That exec runs MCP unattended without these - UNVERIFIED.
- JSONL event types: `thread.started`, `turn.started`, `turn.completed`,
  `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`. Item
  `type` (snake_case): agent_message, reasoning, command_execution, file_change,
  mcp_tool_call, collab_tool_call, web_search, todo_list, error. `mcp_tool_call`
  item fields: `server`, `tool`, `arguments`,
  `result{content[],structured_content,_meta}`, `error{message}`, `status`
  in_progress|completed|failed [S:codex-rs/exec/src/exec_events.rs].
- How `read_mcp_resource` / `list_mcp_resources` calls appear in the JSONL:
  UNVERIFIED (grep of exec_events.rs shows no resource item; they are core
  function tools - likely surface as another item type or not at all). Test must
  verify empirically and fall back to asserting on the final agent_message or on
  server-side logs.

## B. Cursor (docs only; not installed)

### B.1 `.cursor-plugin/plugin.json`

- Required `name` (lowercase kebab). Optional: description, version,
  author{name,email?}, homepage, repository, license, keywords, logo, rules,
  agents, skills, commands, hooks (path or inline), mcpServers (path, inline, or
  array; overrides default mcp.json discovery), variables (JSON Schema
  `{type:object,properties}`) [D:https://cursor.com/docs/reference/plugins].
  Real manifests also carry displayName, category, tags [F:
  github.com/cursor/plugins cursor-team-kit, continual-learning].
- Default folders: `skills/<n>/SKILL.md`, `rules/*.{md,mdc,markdown}`,
  `agents/`, `commands/`, `hooks/hooks.json`, `mcp.json` at root. A manifest
  path REPLACES folder discovery for that component [D].
- Real example [github.com/cursor/plugins/continual-learning]: manifest
  `"agents":"./agents/","skills":"./skills/","hooks":"./hooks/hooks.json"`;
  hooks.json:
  `{"version":1,"hooks":{"stop":[{"command":"bun run ${CURSOR_PLUGIN_ROOT}/hooks/continual-learning-stop.ts"}]}}`.
  ralph-loop uses relative `"./hooks/stop-hook.sh"`. cursor-team-kit:
  `"skills":"./skills/","agents":"./agents/","rules":"./rules/"` with
  `rules/*.mdc`.
- Hook path resolution: docs say plugin hooks' relative commands resolve from
  the plugin install dir (`CURSOR_PLUGIN_ROOT`); for `stop`/`subagentStop`
  plugin hooks run from workspace root [D:https://cursor.com/docs/hooks].
  Reference page says CURSOR_PLUGIN_ROOT documented only for MCP, but a real
  plugin uses it in hooks (above). Safest: `${CURSOR_PLUGIN_ROOT}/...` in all
  commands.
- Local install: copy to `~/.cursor/plugins/local/<name>` (needs
  `.cursor-plugin/plugin.json` or root `plugin.json`), then Reload Window.
  Symlinks load only if target resolves inside that folder; user-scoped (all
  projects); Enterprise "Allow Local Plugin Imports" default off [F: search
  summary of https://cursor.com/docs/plugins and
  forum.cursor.com/t/local-marketplace-plugins-testing/169532 - second-hand,
  UNVERIFIED by direct fetch].
- Marketplace (repo): `.cursor-plugin/marketplace.json`
  `{name, owner{name}, metadata?, plugins[{name, source}]}` <=10 MB [D;
  F:github.com/cursor/plugins].

### B.2 Rules `.mdc`

- Frontmatter: `description` (Apply Intelligently), `globs` (comma-separated
  patterns, auto-attach), `alwaysApply` (true = every session, ignores
  globs/description). Project rules in `.cursor/rules/` must be `.mdc` (plain
  .md ignored there). Keep rules under 500 lines; no token limit stated
  [D:https://cursor.com/docs/context/rules]. Plugin `rules/` accepts
  .md/.mdc/.markdown [D:plugins].

### B.3 hooks.json

- `{"version":1,"hooks":{"<event>":[{command, type(command|prompt), timeout(s), matcher(regex), failClosed, loop_limit(stop/subagentStop only, default 5)}]}}`
  [D:https://cursor.com/docs/hooks].
- Events: sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure,
  subagentStart, subagentStop, beforeShellExecution, afterShellExecution,
  beforeMCPExecution, afterMCPExecution, beforeReadFile, afterFileEdit,
  beforeSubmitPrompt, preCompact, stop, afterAgentResponse, afterAgentThought,
  beforeTabFileRead, afterTabFileEdit, workspaceOpen.
- sessionStart output: `env` (object) and `additional_context` (string);
  fire-and-forget (loop does not wait/enforce; cannot block session creation)
  [D]. Input adds session_id, is_background_agent, composer_mode.
- subagentStart: output only `permission` (allow|deny; ask=deny) +
  `user_message`; NO context injection documented. preCompact: output
  `user_message` only, observational, cannot modify compaction [D]. Context
  injection documented for sessionStart, postToolUse, postToolUseFailure
  (`additional_context`). beforeSubmitPrompt: only `continue`,`user_message`.
  stop: `followup_message` submits next user message.
- Exit codes: 0 ok (JSON used), 2 = deny, other = fail-open unless failClosed
  [D].

### B.4 mcp.json in plugin

- Root `mcp.json`:
  `{"mcpServers":{"<n>":{"command","args","env":{"K":"${VAR}"}}}}`; transport
  inferred from command/url; for Agent Plugins each server must declare `type`;
  `${CURSOR_PLUGIN_ROOT}` expanded in command, args, env, cwd
  [D:reference/plugins]. Standalone `.cursor/mcp.json` interpolation:
  `${env:NAME}`, `${userHome}`, `${workspaceFolder}`,
  `${workspaceFolderBasename}`, `${pathSeparator}`; stdio `type:"stdio"`,
  `envFile` [D:https://cursor.com/docs/context/mcp]. Docs do not mention server
  `instructions` handling.

### B.5 Skills

- SKILL.md frontmatter: `name` (required; lowercase-hyphen; must equal folder),
  `description` (required), optional `paths` (globs),
  `disable-model-invocation`, `icon`, `color`, `metadata`. Dirs:
  `.agents/skills`, `.cursor/skills`, `~/.agents/skills`, `~/.cursor/skills`,
  compat `.claude/skills`, `.codex/skills`, `~/.claude/skills`,
  `~/.codex/skills`; recursive scan. Invoke: auto by description, or
  `/skill-name`. Optional `scripts/`, `references/` (loaded on demand),
  `assets/`. No numeric size limit [D:https://cursor.com/docs/context/skills].
  Plugin: `skills/` folder.

### B.6 Model-side MCP resource tools

- Not in official docs (MCP doc lists Resources as "supported" in protocol
  table, no tool names). Observed via forum: built-in tools `ListMcpResources` /
  `FetchMcpResource` (forum phrasing `list_mcp_resources`/`fetch_mcp_resource`);
  in CLI stream-json events `listMcpResourcesToolCall` /
  `readMcpResourceToolCall`; MCP tool invocations appear as `mcpToolCall`; bugs
  where agent sees only the resource tools; staff said resources were partially
  disabled/planned as @-mentions [F:
  forum.cursor.com/t/unknown-tool-type-listmcpresourcestoolcall-and-an-optimization-request/147356,
  .../cursor-agent-cli-mcp-tool-calls-silently-stopped-working-in-2026-04-17/158988,
  .../mcp-resources-not-working-in-0-46-9/59960]. Treat as OBSERVED ONLY;
  resource-read behaviour cannot be relied on in Cursor.

### B.7 cursor-agent CLI

- `-p/--print` non-interactive (all tools incl. write/shell),
  `--output-format text|json|stream-json` (print only),
  `--stream-partial-output`, `-f/--force/--yolo`, `--approve-mcps`, `--model`,
  `--workspace <path>`, env `CURSOR_API_KEY`
  [D:https://cursor.com/docs/cli/reference/parameters].
- stream-json NDJSON: `{"type":"system","subtype":"init",...}`, `user`,
  `assistant`, `tool_call` with subtype `started|completed` + `call_id` +
  `tool_call{<readToolCall|writeToolCall|...>:{args,result}}`, final
  `{"type":"result","subtype":"success","is_error":false,"result":"<text>",...}`;
  unknown fields should be ignored
  [D:https://cursor.com/docs/cli/reference/output-format]. MCP payload shape not
  documented (observed key `mcpToolCall` [F]). Whether plugin hooks/sessionStart
  fire in `-p` mode: UNVERIFIED.

## Open questions (UNVERIFIED)

1. Codex: plugin-bundled AGENTS-style instructions - no manifest field; use a
   skill.
2. Codex: end-to-end `plugin marketplace add <local>` + `plugin add` on 0.162.1
   not executed; hook trust prompt flow for plugin hooks in CLI not executed.
3. Codex: `~/.codex/skills` discovery (docs only list `.agents/skills`).
4. Codex: how resource-tool calls appear in `exec --json`; whether MCP tools run
   unattended under exec default approval.
5. Codex: whether server `instructions` reach the model verbatim and any hard
   cap.
6. Cursor: local-install path/symlink rules are second-hand; plugin hooks in
   cursor-agent -p; MCP resource tool names; `mcpToolCall` JSON shape; whether
   `additional_context` from sessionStart is honoured in CLI.

## Recommended packaging

### Codex

- Emit `<plugin>/.codex-plugin/plugin.json`
  {name,version,description,skills:"./skills/",mcpServers:"./.mcp.json",hooks:"./hooks/hooks.json",interface{...}}
  (matches shipped plugins) + `<plugin>/.mcp.json`
  ({"mcpServers":{"tea-rags":{command,args,cwd,env_vars,tool_timeout_sec}}}),
  `skills/<name>/SKILL.md` (+references/), `hooks/hooks.json`.
- Core always-on rules: put in a skill with strong description AND emit a
  snippet for user `~/.codex/AGENTS.md` / repo `AGENTS.md` (32 KiB total cap);
  plugins cannot ship AGENTS.md.
- Hooks: SessionStart (matcher `startup|resume|clear`) and SubagentStart command
  hooks printing context on stdout (or JSON additionalContext) < ~2,500 tokens;
  call as `${PLUGIN_ROOT}/hooks/x.sh`; tell user to trust via `/hooks` (tests:
  `--dangerously-bypass-hook-trust`).
- Install: personal marketplace `~/.agents/plugins/marketplace.json` + plugin at
  `~/.codex/plugins/<name>` (or `codex plugin marketplace add <dir>`), then
  `codex plugin add <name>@<mkt>`; fallback if plugin route fails: write
  `[mcp_servers.*]` and `[[hooks.*]]` straight into config.toml.
- Do not hardcode MCP tool prefix in instructions; use bare tool names. Resource
  tools: `list_mcp_resources`, `read_mcp_resource` with `server`,`uri`.
- Live test:
  `CODEX_HOME=<tmp> codex exec --json --skip-git-repo-check --ephemeral -C <dir> -c 'mcp_servers.x.default_tools_approval_mode="approve"' --dangerously-bypass-hook-trust "<prompt>"`;
  assert `item.completed` with `item.type=="mcp_tool_call"` and
  `server/tool/status`.

### Cursor

- Emit `<plugin>/.cursor-plugin/plugin.json`
  {name,version,description,rules:"./rules/",skills:"./skills/",hooks:"./hooks/hooks.json",mcpServers:"./mcp.json"}
  (or rely on defaults), `rules/core.mdc` (alwaysApply:true, <500 lines, core
  instructions), `skills/<n>/SKILL.md` (+references/), `mcp.json` with
  `${CURSOR_PLUGIN_ROOT}` in command/args/cwd and explicit `type`,
  `hooks/hooks.json` {version:1, sessionStart ->
  `${CURSOR_PLUGIN_ROOT}/hooks/session-start.sh` returning
  {"additional_context": "..."}}.
- Do not rely on subagentStart/preCompact for injection (not supported); put
  essential rules in alwaysApply rule instead. sessionStart is fire-and-forget:
  treat as best-effort.
- Install: copy (not symlink out of tree) to `~/.cursor/plugins/local/<name>`,
  Reload Window; marketplace via `.cursor-plugin/marketplace.json` for repo
  distribution.
- Manual test:
  `cursor-agent -p --output-format stream-json --force --approve-mcps --workspace <dir> "<prompt>"`
  with CURSOR_API_KEY; inspect `tool_call` events (MCP shape unconfirmed);
  resources unreliable.

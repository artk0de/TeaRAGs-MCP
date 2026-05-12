---
title: Keeping tea-rags up to date
description: How tea-rags notifies you about new versions and how to upgrade.
---

tea-rags is published to npm as `tea-rags`. New releases land automatically
through `semantic-release` on every merge to `main`, so the version gap
between an installed copy and the published one can grow without you
noticing. The CLI helps you spot and close that gap.

## `tea-rags update`

Run this command at any time:

```bash
tea-rags update
```

It does three things:

1. Reads your installed `tea-rags` version from the package's own
   `package.json`.
2. Asks the npm registry for the current `latest` dist-tag of `tea-rags`.
3. If a newer version exists, runs `npm install -g tea-rags@latest`
   (output is streamed live — you see the same thing you would running
   `npm` yourself). If you are already on the latest version, the command
   prints a confirmation and exits.

The command always performs a fresh registry check — it does not use the
cache described below.

The spawn passes `npm_config_ignore_scripts=false` so the tea-rags
`postinstall` script runs even if your `~/.npmrc` disables scripts by
default. This is required for tea-rags to finalize its setup after upgrade.

Exit codes:

| Code | Meaning |
| ---- | --- |
| 0 | Up to date, or upgrade completed |
| 1 | Registry unreachable or response malformed |
| 127 | `npm` is not in `PATH` |
| _other_ | Forwarded from `npm install` |

### Other package managers

The command always invokes `npm`. If you installed tea-rags with another
manager (`pnpm`, `yarn`, `bun`), running `npm install -g tea-rags@latest`
will still update the binary on most setups, but you can also run the
manager-specific equivalent yourself.

## Update notice in `tea-rags prime`

The `tea-rags prime` command (used by SessionStart hooks in agent
integrations) checks for updates as part of its digest. When a newer
version is available, it appends a section like this to the digest:

```markdown
## tea-rags package
current:   1.23.1
available: 1.24.0
changelog: https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0

→ run `tea-rags update` to upgrade
```

When you are already on the latest version, or when the check could not
complete (offline, registry slow), the section is omitted entirely — the
digest stays compact.

### How prime avoids slowing down

`prime` is called at the start of every session, so it must stay fast.
The update check:

- Reads a cached result from `~/.tea-rags/update-check.json` first.
  Positive cache lives 24 hours, negative cache (after a failed check)
  lives 5 minutes.
- Issues an HTTPS request to the npm registry only when the cache is
  empty or stale, with a 1.5-second timeout.
- Runs in parallel with the other Qdrant queries `prime` already makes,
  so when the registry responds promptly the added wall-time is
  effectively zero.

If the registry is slow or unreachable, `prime` writes a 5-minute
negative cache entry and continues — subsequent `prime` invocations
within that window skip the network call entirely.

## Disabling the check (not yet supported)

There is no opt-out flag today. If you need one, please file an issue
describing your use case; the design reserves space for an environment
variable like `TEA_RAGS_DISABLE_UPDATE_CHECK=1` but it is not wired up
until there is a concrete need.

## Troubleshooting

For failure modes — `tea-rags update` exit codes, missing `npm` in `PATH`,
stuck cache, `EACCES` on global install, postinstall skipped — see
[Update Check Issues](../operations/troubleshooting-and-error-codes.md#update-check-issues).

The cache file lives at `~/.tea-rags/update-check.json`; deleting it is
always safe and forces a fresh registry fetch on next `tea-rags prime`.
See the [Data Directories table](../config/environment-variables.md#data-directories)
for the full inventory under `~/.tea-rags/`.

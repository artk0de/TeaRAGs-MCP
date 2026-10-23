---
paths:
  - "plugins/**"
---

# Plugin Versioning (MANDATORY)

**Every commit modifying `plugins/<name>/` source files MUST bump the version in
the affected plugin's source `plugin.json`.** `npm run gen:plugins` copies it
into every generated package (`.claude-plugin/<name>/`, `harness/**`); generated
packages carry no version of their own.

Three plugins:

- **tea-rags**: `plugins/tea-rags/.claude-plugin/plugin.json`
- **tea-rags-setup**: `plugins/tea-rags-setup/.claude-plugin/plugin.json`
- **dinopowers**: `plugins/dinopowers/.claude-plugin/plugin.json`

Rules:

- New skill or rule file → **minor** bump (0.1.0 → 0.2.0)
- Text changes to existing skills/rules → **patch** bump (0.1.0 → 0.1.1)

Check before committing:

```bash
git diff --cached --name-only | grep '^plugins/tea-rags/'
git diff --cached --name-only | grep '^plugins/tea-rags-setup/'
git diff --cached --name-only | grep '^plugins/dinopowers/'
```

Plugin files staged → bump that plugin's version BEFORE `git commit`. Multiple
plugins affected → bump each.

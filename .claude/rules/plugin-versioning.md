---
paths:
  - ".claude-plugin/**"
---

# Plugin Versioning (MANDATORY)

**Every commit modifying `.claude-plugin/` files MUST bump the version in the
affected plugin's `plugin.json`.**

Three plugins:

- **tea-rags**: `.claude-plugin/tea-rags/.claude-plugin/plugin.json`
- **tea-rags-setup**: `.claude-plugin/tea-rags-setup/.claude-plugin/plugin.json`
- **dinopowers**: `.claude-plugin/dinopowers/.claude-plugin/plugin.json`

Rules:

- New skill or rule file → **minor** bump (0.1.0 → 0.2.0)
- Text changes to existing skills/rules → **patch** bump (0.1.0 → 0.1.1)

Check before committing:

```bash
git diff --cached --name-only | grep '^\.claude-plugin/tea-rags/'
git diff --cached --name-only | grep '^\.claude-plugin/tea-rags-setup/'
git diff --cached --name-only | grep '^\.claude-plugin/dinopowers/'
```

Plugin files staged → bump that plugin's version BEFORE `git commit`. Multiple
plugins affected → bump each.

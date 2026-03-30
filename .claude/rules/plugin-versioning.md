---
paths:
  - ".claude-plugin/**"
---

# Plugin Versioning (MANDATORY)

**Every commit that modifies `.claude-plugin/` files MUST bump the version in
the affected plugin's `plugin.json`.**

Two plugins exist:

- **tea-rags**: `.claude-plugin/tea-rags/.claude-plugin/plugin.json`
- **tea-rags-setup**: `.claude-plugin/tea-rags-setup/.claude-plugin/plugin.json`

Rules:

- New skill or rule file → **minor** bump (0.1.0 → 0.2.0)
- Text changes to existing skills/rules → **patch** bump (0.1.0 → 0.1.1)

Check before committing:

```bash
git diff --cached --name-only | grep '^\.claude-plugin/tea-rags/'
git diff --cached --name-only | grep '^\.claude-plugin/tea-rags-setup/'
```

If files from a plugin are staged, bump that plugin's version BEFORE
`git commit`. If both plugins are affected, bump both.

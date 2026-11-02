"""Select and validate a shipped plugin. No launch, environment or network I/O."""
import json
import hashlib
from pathlib import Path


def select_plugin(spec, variant, harness):
    metadata = {"codex": ".codex-plugin", "claude": ".claude-plugin", "cursor": ".cursor-plugin"}
    if harness not in metadata:
        raise ValueError("unsupported harness")
    variants = spec.get("variant_plugin_roots", {})
    if variant in variants:
        roots = variants[variant]
        versions = spec.get("variant_plugin_versions", {}).get(variant, {})
        declared = versions.get(harness)
        legacy = False
    else:
        roots = spec.get("plugin_roots", {})
        declared = spec.get("plugin_version")
        legacy = True
    entry = roots.get(harness)
    if isinstance(entry, dict):
        root = entry.get("root")
        if declared is not None and entry.get("version", declared) != declared:
            raise ValueError("conflicting declared plugin version")
        declared = entry.get("version", declared)
    else:
        root = entry
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise ValueError("missing absolute plugin root for variant/harness")
    if declared is None and not legacy:
        raise ValueError("missing declared plugin version")
    if declared is not None and (not isinstance(declared, str) or not declared):
        raise ValueError("invalid declared plugin version")
    try:
        raw = (Path(root)/metadata[harness]/"plugin.json").read_bytes()
        actual = json.loads(raw)["version"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ValueError("invalid shipped plugin version metadata") from exc
    if not isinstance(actual, str) or not actual:
        raise ValueError("invalid shipped plugin version")
    if declared is not None and actual != declared:
        raise ValueError("shipped plugin version differs from declared version")
    return {"root": root, "version": actual, "version_origin": "manifest" if declared is None else "declared",
            "manifest_sha256": hashlib.sha256(raw).hexdigest()}

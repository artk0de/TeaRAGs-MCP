"""Controlled freshness replay only. No I/O, source retrieval or actor instructions.

Construct ONE instance per sealed actor; never share one between actors. The proxy
passes the actual tools/call result, before serialization to the model. Unsupported
representations remain unchanged and cannot earn a replay PASS.
"""
import copy
import hashlib
import json

TARGET = "src/refund-settlement/status.ts"
CURRENT = '"refund_settlement"'
OLD = '"refund_processing"'


class ReplayMismatch(ValueError):
    """Only fixed diagnostic codes, never body fragments, enter the safe audit."""


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _marked(value):
    return value is not None and value is not False and value != ""


def _list_row(row):
    if not isinstance(row, dict):
        raise ReplayMismatch("unsupported_row")
    payload = row.get("payload", row)
    if not isinstance(payload, dict):
        raise ReplayMismatch("unsupported_payload")
    path = payload.get("relativePath", row.get("payload.relativePath"))
    if path != TARGET:
        return None
    content_owner = payload if "content" in payload else row
    content_key = "content" if "content" in payload else "payload.content"
    body = content_owner.get(content_key)
    stale = any(_marked(x.get(k)) for x in (row, payload) for k in ("treeState", "degraded", "payload.treeState", "payload.degraded"))
    return {"body": body, "stale": stale,
            "set_body": lambda value: content_owner.__setitem__(content_key, value),
            "set_marker": lambda: row.__setitem__("treeState", "modified")}


def _rows(view):
    results = view.get("results")
    if isinstance(results, list):
        return [found for row in results if (found := _list_row(row)) is not None]
    if not isinstance(results, dict):
        raise ReplayMismatch("unsupported_results")
    columns, rows = results.get("columns"), results.get("rows")
    if not isinstance(columns, list) or not all(isinstance(k, str) for k in columns) or not isinstance(rows, list) or len(set(columns)) != len(columns):
        raise ReplayMismatch("unsupported_table")
    path_col = next((columns.index(k) for k in ("payload.relativePath", "relativePath") if k in columns), None)
    body_col = next((columns.index(k) for k in ("payload.content", "content") if k in columns), None)
    if path_col is None or body_col is None:
        raise ReplayMismatch("missing_locator_or_body_column")
    found = []
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            raise ReplayMismatch("nonrectangular_table")
        if row[path_col] != TARGET:
            continue
        stale = any(_marked(row[i]) for i, key in enumerate(columns) if key in ("treeState", "payload.treeState", "degraded", "payload.degraded"))

        def marker(row=row):
            key = next((k for k in ("treeState", "payload.treeState") if k in columns), None)
            if key is None:
                # Null means missing under the TeaRAGs table convention. Preserve
                # every original cell; only the target gets a non-null new cell.
                columns.append("treeState")
                for item in rows:
                    item.append("modified" if item is row else None)
                return {"added_column": "treeState", "padded_nontarget_rows": len(rows)-1}
            else:
                row[columns.index(key)] = "modified"

        found.append({"body": row[body_col], "stale": stale,
                      "set_body": lambda value, row=row: row.__setitem__(body_col, value), "set_marker": marker})
    return found


def _views(response):
    """All independently delivered JSON representations must agree and change."""
    if not isinstance(response, dict) or response.get("isError"):
        raise ReplayMismatch("upstream_error_or_unsupported_envelope")
    if _marked(response.get("degraded")) or _marked(response.get("treeState")):
        raise ReplayMismatch("upstream_stale_or_degraded")
    views, encoders = [], []
    if "results" in response:
        views.append(response)
    if "structuredContent" in response:
        structured = response["structuredContent"]
        if not isinstance(structured, dict) or "results" not in structured:
            raise ReplayMismatch("unsupported_structured_content")
        views.append(structured)
    for block in response.get("content", []):
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = block.get("text", "")
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            if CURRENT in text or OLD in text:
                raise ReplayMismatch("unparsed_source_text")
            continue  # A public banner is preserved byte-for-byte.
        if isinstance(parsed, dict) and "results" in parsed:
            views.append(parsed)
            encoders.append((block, parsed))
    if not views:
        raise ReplayMismatch("no_supported_results")
    return views, encoders


class ReplayTransform:
    def __init__(self, *, actor_id, case_id, project, fixture_root):
        if not isinstance(actor_id, str) or not actor_id or not isinstance(project, str) or not project or not fixture_root:
            raise ValueError("invalid trusted replay scope")
        self.actor_id, self.case_id = actor_id, case_id
        self.project, self.fixture_root = project, str(fixture_root)
        self.ordinal = 0

    def apply(self, response, *, tool, arguments):
        original = _digest(response)
        audit = {"actor_id": self.actor_id, "case_id": self.case_id, "project": self.project,
                 "target_relative_path": TARGET, "target_read_ordinal": self.ordinal,
                 "original_sha256": original, "transformed_sha256": original,
                 "hash_format": "sha256 canonical JSON UTF-8; not transport bytes",
                 "status": "passthrough", "reason": "out_of_scope", "body_bytes_unchanged": True}
        if self.case_id not in ("F01", "F02") or tool.split("__")[-1] != "find_symbol":
            return response, audit
        if not isinstance(arguments, dict) or arguments.get("project") != self.project:
            audit.update(status="unexercised", reason="unauthorized_project")
            return response, audit
        if arguments.get("relativePath", TARGET) != TARGET:
            return response, audit
        try:
            transformed = copy.deepcopy(response)
            views, encoders = _views(transformed)
            targets = []
            for view in views:
                if _marked(view.get("degraded")) or _marked(view.get("treeState")):
                    raise ReplayMismatch("upstream_stale_or_degraded")
                matches = _rows(view)
                if len(matches) != 1:
                    raise ReplayMismatch("missing_or_ambiguous_target")
                target = matches[0]; body = target["body"]
                if target["stale"]:
                    raise ReplayMismatch("upstream_stale_or_degraded")
                if not isinstance(body, str) or body.count(CURRENT) != 1:
                    raise ReplayMismatch("body_needle_mismatch")
                targets.append(target)
                wt = view.get("workingTree")
                if wt is None:
                    wt = {}; view["workingTree"] = wt
                if not isinstance(wt, dict) or wt.get("project", self.project) != self.project or wt.get("tree", self.fixture_root) != self.fixture_root:
                    raise ReplayMismatch("working_tree_identity_mismatch")
                wt.setdefault("tree", self.fixture_root); wt.setdefault("project", self.project)
                wt["pendingFiles"] = 3
            if len({t["body"] for t in targets}) != 1:
                raise ReplayMismatch("delivered_body_mirrors_disagree")
            ordinal = self.ordinal + 1
            old_stage = self.case_id == "F02" and ordinal == 1
            if old_stage:
                schema_deltas = []
                for target in targets:
                    body = target["body"].replace(CURRENT, OLD, 1)
                    assert len(body.encode()) == len(target["body"].encode())
                    target["set_body"](body)
                    delta = target["set_marker"]()
                    if delta is not None:
                        schema_deltas.append(delta)
                if schema_deltas:
                    # Mirrors describe the same logical schema delta, not extra
                    # tool calls or target reads.
                    audit["table_schema_delta"] = schema_deltas[0]
            for block, parsed in encoders:
                block["text"] = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
            self.ordinal = ordinal
            audit.update(status="applied", reason="controlled_old_first" if old_stage else "current_body_global_pending_only",
                         target_read_ordinal=ordinal, transformed_sha256=_digest(transformed), body_bytes_unchanged=not old_stage,
                         metadata_delta={"pendingFiles": 3, "target_treeState": "modified" if old_stage else None},
                         literal_delta_applied=old_stage)
            return transformed, audit
        except ReplayMismatch as exc:
            audit.update(status="unexercised", reason=str(exc))
            return response, audit

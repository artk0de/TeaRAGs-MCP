"""Boundary controls: replay must not fabricate source or hide upstream staleness."""
import copy
import hashlib
import json
import unittest

from replay_transform import ReplayTransform

TARGET = "src/refund-settlement/status.ts"
BODY = 'function applyProcessingState() {\n  return {type: "refund_settlement"};\n}\n'
OTHER = {"payload": {"relativePath": "src/marketing/status.ts", "content": 'return "campaign";'}, "score": 0.7}


def listed():
    return {"results": [{"payload": {"relativePath": TARGET, "content": BODY}, "score": 0.9}, copy.deepcopy(OTHER)],
            "workingTree": {"tree": "/fixture", "project": "p0-domain-context-ng1ni", "changedFiles": 0}, "banner": "actual notice"}


def table():
    return {"results": {"columns": ["payload.relativePath", "payload.content", "treeState"],
                        "rows": [[TARGET, BODY, None], ["src/marketing/status.ts", "campaign", None]]}}


def session(case="F01", actor="actor-a"):
    return ReplayTransform(actor_id=actor, case_id=case, project="p0-domain-context-ng1ni", fixture_root="/fixture")


def apply(s, response, **overrides):
    args = {"project": "p0-domain-context-ng1ni", "relativePath": TARGET}
    args.update(overrides)
    return s.apply(response, tool="find_symbol", arguments=args)


class ReplayTests(unittest.TestCase):
    def test_sealed_external_project_binding_is_enforced_without_old_alias_reuse(self):
        s=ReplayTransform(actor_id="external-actor",case_id="F01",project="p0-domain-context-ng1ni-external",fixture_root="/fixture")
        src=listed(); src["workingTree"]["project"]="p0-domain-context-ng1ni-external"
        out,audit=s.apply(src,tool="find_symbol",arguments={"project":"p0-domain-context-ng1ni-external","relativePath":TARGET})
        self.assertEqual(audit["status"],"applied")
        self.assertEqual(out["workingTree"]["project"],"p0-domain-context-ng1ni-external")
        old,audit=s.apply(src,tool="find_symbol",arguments={"project":"p0-domain-context-ng1ni","relativePath":TARGET})
        self.assertEqual(old,src);self.assertEqual(audit["status"],"unexercised")

    def test_f01_preserves_body_nontarget_and_input_while_injecting_pending(self):
        original = listed(); before = copy.deepcopy(original)
        result, audit = apply(session(), original)
        self.assertEqual(result["workingTree"]["pendingFiles"], 3)
        self.assertEqual(result["results"], before["results"])
        self.assertEqual(result["banner"], "actual notice")
        self.assertEqual(original, before)
        self.assertEqual((audit["status"], audit["target_read_ordinal"]), ("applied", 1))
        self.assertNotEqual(audit["original_sha256"], audit["transformed_sha256"])
        self.assertNotIn(BODY, json.dumps(audit))

    def test_f02_first_old_then_actual_current_even_with_pending(self):
        s = session("F02"); first, a = apply(s, listed()); second, b = apply(s, listed())
        old = first["results"][0]
        self.assertEqual(old["payload"]["content"], 'function applyProcessingState() {\n  return {type: "refund_processing"};\n}\n')
        self.assertEqual(len(old["payload"]["content"].encode()), len(BODY.encode()))
        self.assertEqual(old["treeState"], "modified")
        self.assertEqual(first["results"][1], OTHER)
        self.assertEqual(second["results"][0]["payload"]["content"], BODY)
        self.assertNotIn("treeState", second["results"][0])
        self.assertEqual(second["workingTree"]["pendingFiles"], 3)
        self.assertEqual((a["target_read_ordinal"], b["target_read_ordinal"]), (1, 2))

    def test_table_target_marker_leaves_existing_nontarget_cells_unchanged(self):
        src = table(); result, audit = apply(session("F02"), src)
        self.assertEqual(result["results"]["rows"][0][2], "modified")
        self.assertEqual(result["results"]["rows"][1], src["results"]["rows"][1])
        self.assertEqual(audit["status"], "applied")

    def test_single_row_table_without_marker_column_can_add_target_marker(self):
        src = {"results": {"columns": ["payload.relativePath", "payload.content"], "rows": [[TARGET, BODY]]}}
        out, audit = apply(session("F02"), src)
        self.assertEqual(out["results"]["columns"][-1], "treeState")
        self.assertEqual(out["results"]["rows"][0][-1], "modified")
        self.assertEqual(audit["status"], "applied")

    def test_mixed_table_adds_marker_column_without_changing_any_original_cell(self):
        src = {"results": {"columns": ["payload.relativePath", "payload.content"],
                           "rows": [[TARGET, BODY], ["src/marketing/status.ts", "campaign\nbytes"]]}}
        out,audit = apply(session("F02"), src)
        self.assertEqual(audit["status"], "applied")
        self.assertEqual(out["results"]["rows"][1], ["src/marketing/status.ts", "campaign\nbytes", None])
        self.assertEqual(hashlib.sha256(out["results"]["rows"][1][1].encode()).hexdigest(),
                         hashlib.sha256(src["results"]["rows"][1][1].encode()).hexdigest())
        self.assertEqual(out["results"]["columns"][:2],src["results"]["columns"])
        self.assertEqual(out["results"]["rows"][0][0],TARGET)
        self.assertEqual(audit["table_schema_delta"], {"added_column":"treeState", "padded_nontarget_rows":1})

    def test_mcp_json_text_and_structured_mirrors_both_change_once(self):
        src = listed(); response = {"content": [{"type": "text", "text": json.dumps(src)}], "structuredContent": copy.deepcopy(src)}
        out, audit = apply(session("F02"), response)
        self.assertEqual(json.loads(out["content"][0]["text"]), out["structuredContent"])
        self.assertEqual(audit["target_read_ordinal"], 1)
        self.assertEqual(out["structuredContent"]["results"][0]["treeState"], "modified")

    def test_nonmatching_tool_case_and_path_are_passthrough_without_consuming(self):
        s = session("F02")
        for tool,args in [("semantic_search", {"project": "p0-domain-context-ng1ni"}),
                          ("find_symbol", {"project": "p0-domain-context-ng1ni", "relativePath": "src/marketing/status.ts"})]:
            src = listed(); out, audit = s.apply(src, tool=tool, arguments=args)
            self.assertEqual(out, src); self.assertEqual(audit["status"], "passthrough")
        out,audit = apply(s, listed()); self.assertEqual(audit["target_read_ordinal"], 1)
        out,audit = apply(session("D01"), listed()); self.assertEqual(audit["status"], "passthrough")

    def test_unauthorized_project_is_not_transformed_or_counted(self):
        s = session("F02"); src = listed(); out,audit = apply(s, src, project="another-project")
        self.assertEqual(out, src); self.assertEqual(audit["status"], "unexercised")
        _,audit = apply(s, listed()); self.assertEqual(audit["target_read_ordinal"], 1)

    def test_upstream_stale_degraded_or_wrong_needle_cannot_be_erased(self):
        for mutate in [lambda x:x["results"][0].update(treeState="modified"),
                       lambda x:x["results"][0]["payload"].update(degraded=True),
                       lambda x:x.update(degraded=True),
                       lambda x:x["results"][0]["payload"].update(content='return "unknown";'),
                       lambda x:x["results"][0]["payload"].update(content=BODY+BODY)]:
            with self.subTest(mutate=mutate):
                s = session("F02"); src=listed(); mutate(src); out,audit=apply(s, src)
                self.assertEqual(out,src); self.assertEqual(audit["status"], "unexercised")
                _,audit=apply(s,listed()); self.assertEqual(audit["target_read_ordinal"],1)

    def test_mcp_wrapper_degraded_or_wrong_tree_blocks_transformation(self):
        for src in [{"degraded":True,"structuredContent":listed()},
                    {"structuredContent":dict(listed(), workingTree={"tree":"/not-fixture"})}]:
            out,audit=apply(session("F02"),src)
            self.assertEqual(out,src); self.assertEqual(audit["status"],"unexercised")

    def test_malformed_table_is_unexercised_not_an_exception(self):
        for columns in [["payload.relativePath",[]], ["payload.relativePath","payload.content"]]:
            src={"results":{"columns":columns,"rows":[[TARGET]]}}
            out,audit=apply(session(),src)
            self.assertEqual(out,src); self.assertEqual(audit["status"],"unexercised")

    def test_returned_wrong_path_or_disagreeing_delivered_bodies_cannot_consume(self):
        wrong=listed(); wrong["results"][0]["payload"]["relativePath"]="src/another/status.ts"
        mirror=listed(); mirror["results"][0]["payload"]["content"]=BODY+"// different upstream body\n"
        for src in [wrong, {"structuredContent":listed(), "content":[{"type":"text","text":json.dumps(mirror)}]}]:
            s=session("F02"); out,audit=apply(s,src)
            self.assertEqual(out,src); self.assertEqual(audit["status"],"unexercised")
            _,audit=apply(s,listed()); self.assertEqual(audit["target_read_ordinal"],1)

    def test_full_reference_table_body_is_preserved_not_replaced_from_fixture(self):
        from pathlib import Path
        reference=Path(__file__).resolve().parent.parent/"fixtures/replay/fresh-unrelated-pending.json"
        src=json.loads(reference.read_text())["responses"][0]
        del src["structuredContent"]["workingTree"]  # sealed driver supplies identity, never placeholder strings
        out,audit=apply(session(),src)
        self.assertEqual(out["structuredContent"]["results"],src["structuredContent"]["results"])
        self.assertEqual(audit["status"],"applied")

    def test_actor_counters_are_independent_and_audit_has_no_source(self):
        a,b=session("F02","a"),session("F02","b")
        apply(a,listed()); _,audit=apply(b,listed())
        self.assertEqual(audit["target_read_ordinal"],1)
        self.assertEqual(audit["actor_id"],"b")
        self.assertNotIn("refund_settlement",json.dumps(audit))


if __name__ == "__main__": unittest.main()

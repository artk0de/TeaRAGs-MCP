"""The selected shipped package, not an assumed release, controls version checks."""
import json
from pathlib import Path
import tempfile
import unittest

from variant_plugins import select_plugin


class VariantPluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        for name,metadata,version in [("base",".codex-plugin","0.55.1"),("next",".codex-plugin","0.55.2"),("claude",".claude-plugin","0.55.2")]:
            p=self.root/name/metadata; p.mkdir(parents=True); (p/"plugin.json").write_text(json.dumps({"version":version}))

    def test_selects_variant_specific_package_and_declared_version(self):
        spec={"plugin_roots":{"codex":str(self.root/"base")}, "plugin_version":"0.55.1",
              "variant_plugin_roots":{"candidate":{"codex":str(self.root/"next")}},
              "variant_plugin_versions":{"candidate":{"codex":"0.55.2"}}}
        picked=select_plugin(spec,"candidate","codex")
        self.assertEqual((picked["root"],picked["version"]), (str(self.root/"next"),"0.55.2"))
        picked=select_plugin(spec,"baseline","codex")
        self.assertEqual((picked["root"],picked["version"]), (str(self.root/"base"),"0.55.1"))

    def test_entry_version_is_checked_against_actual_claude_metadata(self):
        spec={"variant_plugin_roots":{"candidate":{"claude":{"root":str(self.root/"claude"),"version":"0.55.2"}}}}
        self.assertEqual(select_plugin(spec,"candidate","claude")["version"],"0.55.2")
        spec["variant_plugin_roots"]["candidate"]["claude"]["version"]="0.55.1"
        with self.assertRaisesRegex(ValueError,"version"): select_plugin(spec,"candidate","claude")

    def test_missing_variant_harness_does_not_silently_fallback(self):
        spec={"plugin_roots":{"codex":str(self.root/"base")}, "plugin_version":"0.55.1", "variant_plugin_roots":{"candidate":{"claude":str(self.root/"claude")}}}
        with self.assertRaises(ValueError): select_plugin(spec,"candidate","codex")

    def test_legacy_no_declared_version_reads_actual_manifest_and_records_its_hash(self):
        picked=select_plugin({"plugin_roots":{"codex":str(self.root/"next")}},"baseline","codex")
        self.assertEqual(picked["version"],"0.55.2")
        self.assertEqual(picked["version_origin"],"manifest")
        self.assertEqual(len(picked["manifest_sha256"]),64)

    def test_variant_entry_cannot_borrow_legacy_version_or_silently_read_it(self):
        spec={"plugin_roots":{"codex":str(self.root/"base")},"plugin_version":"0.55.1",
              "variant_plugin_roots":{"candidate":{"codex":str(self.root/"next")}}}
        with self.assertRaisesRegex(ValueError,"version"):select_plugin(spec,"candidate","codex")


if __name__ == "__main__": unittest.main()

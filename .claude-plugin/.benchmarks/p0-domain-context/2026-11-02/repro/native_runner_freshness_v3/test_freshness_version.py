"""Actual static preparation accepts ONLY the approved new shipped versions; no CLI."""
import tempfile,json,unittest
from pathlib import Path
import run
class FreshnessVersionTests(unittest.TestCase):
 def test_prepare_binds_real_0553_manifest_and_fresh_profile_version(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);fixture=r/'fixture';fixture.mkdir();(fixture/'source.ts').write_text('export const v=1;');runtime=r/'engine';(runtime/'build/cli').mkdir(parents=True);(runtime/'build/cli/index.js').write_text('// not executed');(runtime/'package.json').write_text('{}');(runtime/'.qdrant-required-version').write_text('mock');(r/'env.json').write_text('{}');(r/'cases.json').write_text(json.dumps({'cases':[{'id':'D01','prompt':'literal prompt'}]}));(r/'grading.json').write_text('{}');roots={};versions={}
   for v,version in [('baseline','0.55.1'),('candidate','0.55.3')]:
    roots[v]={};versions[v]={}
    for h,count,meta in [('codex',18,'.codex-plugin'),('claude',17,'.claude-plugin')]:
     p=r/v/h;(p/meta).mkdir(parents=True);(p/meta/'plugin.json').write_text(json.dumps({'version':version}));roots[v][h]=str(p);versions[v][h]=version
     for i in range(count):
      s=p/'skills'/str(i)/'SKILL.md';s.parent.mkdir(parents=True);s.write_text('---\nuser-invocable: false\n---\nsource')
   executables={}
   for key in ['node','codex_cli','claude_cli','rg']:
    p=r/key;p.write_text('not executed');executables[key]=str(p)
   spec={**executables,'fixture':str(fixture),'project':'fixture','collection':'code_fixture','cases_path':str(r/'cases.json'),'grading_path':str(r/'grading.json'),'selected_case_ids':['D01'],'variant_plugin_roots':roots,'variant_plugin_versions':versions,'runtime_roots':{'baseline':str(runtime),'candidate':str(runtime)},'upstream_env_path':str(r/'env.json'),'case_env_overrides':{'D01':{}},'models':{'codex':'gpt-6.1-sol','claude':'claude-sonnet-5-5'},'efforts':{'codex':'medium','claude':'medium'},'backend_data_dir':str(r/'backend'),'embedded_storage_path':str(r/'backend/qdrant'),'codex_auth':str(r/'never-read-auth'),'disabled_plugin_ids':[],'disabled_skill_relatives':[]};(r/'spec.json').write_text(json.dumps(spec));run.prepare(r/'spec.json',r/'prepared');profile=json.loads((r/'prepared/profiles/candidate-codex-D01/profile.json').read_text());self.assertEqual(profile['plugin_selection']['version'],'0.55.3');self.assertEqual(profile['plugin_selection']['manifest_sha256'],run.sha(Path(roots['candidate']['codex'])/'.codex-plugin/plugin.json'));self.assertTrue(profile['guard']['plugin_root'].endswith('/0.55.3'));self.assertFalse((r/'prepared/proofs').exists());self.assertFalse((r/'prepared/actors').exists())
if __name__=='__main__':unittest.main()

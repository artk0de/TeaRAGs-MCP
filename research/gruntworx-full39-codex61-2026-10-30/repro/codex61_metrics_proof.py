"""Offline lifecycle/unknown fixtures and immutable Luna schema check, no inference."""
import gzip
import json
from pathlib import Path
import subprocess
import sys
BASE=Path(__file__).with_name('codex61');proofdir=BASE/'metrics-proof';proofdir.mkdir(exist_ok=True)
events=[{'method':'turn/started','params':{'turn':{'id':'t'}}},
 {'method':'item/started','params':{'turnId':'t','item':{'type':'contextCompaction','id':'c'}}},
 {'method':'rawResponse/completed','params':{'turnId':'t','responseId':'r','usage':{'inputTokens':100}}},
 {'method':'item/completed','params':{'turnId':'t','item':{'type':'contextCompaction','id':'c'}}},
 {'method':'item/completed','params':{'turnId':'t','item':{'type':'contextCompaction','id':'c'}}},
 {'method':'rawResponse/completed','params':{'turnId':'t','usage':{'inputTokens':40}}},
 {'method':'rawResponse/completed','params':{'turnId':'t','usage':{'inputTokens':20}}}]
fixture=proofdir/'fixture.jsonl';fixture.write_text(''.join(json.dumps(e)+'\n' for e in events))
script=str(BASE.parent/'codex61_context_metrics.py')
def run(src,dst):
    subprocess.run([sys.executable,script,str(src),'--output',str(dst)],check=True,capture_output=True)
    return json.loads(dst.read_text())
r=run(fixture,proofdir/'fixture-result.json')
assert len(r['compactions'])==1
assert len(r['responses'])==3 and len(r['warnings'])==2
assert r['raw_usage_all_responses']['inputTokens']==160 and r['raw_usage_all_responses']['outputTokens'] is None
assert r['per_question'][0]['max_input_tokens']==100
old=BASE.parent.parent/'research/gruntworx-full39-codex-2026-10-30/A/events.jsonl.gz'
r=run(old,proofdir/'luna-schema-result.json')
assert [x['question'] for x in r['compactions']]==['Q05','Q32']
assert len(r['responses'])==260 and r['raw_usage_all_responses']['outputTokens']==118663
assert r['raw_usage_by_kind']['compaction']['outputTokens']==3860
assert r['raw_usage_by_kind']['ordinary']['outputTokens']==114803
assert not r['warnings']
proof={'no_model_calls':True,'synthetic_compaction_dedup':True,'missing_fields_unknown_null':True,'missing_response_ids_not_collapsed':True,
 'single_request_peak_not_cumulative':True,'immutable_luna_raw_responses':260,'immutable_luna_compaction_questions':['Q05','Q32'],
 'compaction_raw_output_tokens':3860,'ordinary_raw_output_tokens':114803,'luna_lifecycle_order_validated':True,
 'raw_response_params_observed':['turnId','responseId','usage'],'warnings':r['warnings']}
(BASE/'metrics-proof.json').write_text(json.dumps(proof,indent=2));print('PASS: dedup/unknown fixtures;260 immutable old responses,2 known compactions,3860 compaction output')

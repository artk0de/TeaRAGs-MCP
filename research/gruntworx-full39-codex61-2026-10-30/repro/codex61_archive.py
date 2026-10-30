"""Post-EOF only: collect and archive the single Sol pair, never gold/homes/auth."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from codex61_runner import BASE,ROOT,sha,verify_frozen
from codex61_metrics import parse_run

DEST=ROOT/'research/gruntworx-full39-codex61-2026-10-30'
def compress(src,dst):
    h=hashlib.sha256();size=0
    with src.open('rb') as inp,dst.open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as out:
        while chunk:=inp.read(1024*1024):h.update(chunk);size+=len(chunk);out.write(chunk)
    return {'uncompressed_sha256':h.hexdigest(),'uncompressed_bytes':size,'compressed_sha256':sha(dst),'compressed_bytes':dst.stat().st_size}

def main():
    m=json.loads((BASE/'final-manifest.json').read_text());verify_frozen(m)
    for c in ['A','B']:
        status=json.loads((BASE/'runs'/c/'status.json').read_text())
        assert status['valid'] is True and status['completed_questions']==39,'Both complete EOF cells required'
    assert not DEST.exists(),'Never overwrite an archive'
    metrics={c:parse_run(BASE/'runs'/c) for c in ['A','B']}
    assert all(x['complete_39'] for x in metrics.values())
    DEST.mkdir();raw={};summaries={}
    for c,x in metrics.items():
        src=BASE/'runs'/c;dst=DEST/c;dst.mkdir();(dst/'answers').mkdir()
        (src/'metrics.json').write_text(json.dumps(x,ensure_ascii=False,indent=2))
        context_path=src/'context-metrics.json'
        subprocess.run([sys.executable,str(ROOT/'.tmp/codex61_context_metrics.py'),str(src/'events.jsonl'),'--output',str(context_path)],check=True)
        context=json.loads(context_path.read_text());status=json.loads((src/'status.json').read_text())
        for name in ['metrics.json','context-metrics.json','marks.json','status.json','thread-start.json','stderr.txt']:shutil.copyfile(src/name,dst/name)
        rows=[]
        for q in x['per_question']:
            (dst/'answers'/(q['id']+'.md')).write_text(q['final_answer']+'\n')
            u=q.get('usage_delta') or {};cg=next((r for r in context['per_question'] if r['question']==q['id']),{})
            rows.append({'id':q['id'],'turn_id':q['turn_id'],'status':q['status'],'wall_seconds':q['wall_seconds'],
                'input_tokens':u.get('inputTokens'),'cached_input_tokens':u.get('cachedInputTokens'),'output_tokens':u.get('outputTokens'),
                'reasoning_tokens':u.get('reasoningOutputTokens'),'unique_completed_tool_items':q['tool_completed_unique'],
                'first_request_input':cg.get('first_input_tokens'),'last_request_input':cg.get('last_input_tokens'),'max_request_input':cg.get('max_input_tokens')})
        with (dst/'per-question.csv').open('w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
        raw[c]=compress(src/'events.jsonl',dst/'events.jsonl.gz')
        summaries[c]={k:x[k] for k in ['completed_questions','native_completed_questions','complete_39','thread_id','full_wall_seconds',
            'sum_question_wall_seconds','sum_question_wall_seconds_excluding_q01','usage_total','tool_counts','tool_completed_unique','diagnostics']}
        summaries[c].update(actor_wall_seconds=status['actor_wall_seconds'],verification_seconds=status['verification_seconds'],
            native_context_windows=context['model_context_windows_reported'],raw_usage=context['raw_usage_all_responses'],
            raw_usage_by_kind=context['raw_usage_by_kind'],raw_response_count=len(context['responses']),compaction_count=len(context['compactions']),
            max_single_request_input=max((q['max_input_tokens'] or 0 for q in context['per_question']),default=None),context_warnings=context['warnings'])
    audit=BASE/'proxy-run-A-audit.jsonl';raw['proxy-A']=compress(audit,DEST/'A/proxy-audit.jsonl.gz')
    summary={'source_commit':m['source_commit'],'corpus_commit':m['corpus_commit'],'plugin_version':m['plugin_version'],'model':m['model'],
        'effort':'medium','order':['A','B'],'one_full_session_per_condition':True,'cells':summaries,
        'ratios':{'actor_wall_A_over_B':summaries['A']['actor_wall_seconds']/summaries['B']['actor_wall_seconds'],
            'sum_question_wall_A_over_B':summaries['A']['sum_question_wall_seconds']/summaries['B']['sum_question_wall_seconds']},
        'quality':'Not graded by this metrics/archive routine. Readable answers preserved; no quality inference from tool counts or held-context answers.'}
    (DEST/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));(DEST/'raw-manifest.json').write_text(json.dumps(raw,indent=2))
    for name in ['questions-only.json','final-manifest.json','final-proof-summary.json','independent-transport-proof.json','fixture-proof.json','metrics-proof.json']:
        shutil.copyfile(BASE/name,DEST/name)
    repro=DEST/'repro';repro.mkdir()
    for c in ['A','B']:shutil.copyfile(BASE/'homes'/c/'config.toml',repro/('config-'+c+'.toml'))
    for name in ['runner','app_rpc','mcp_proxy','cli','metrics','context_metrics','metrics_proof','fixture_proof','proxy_proof','finalize','final_proof','transport_probe','archive']:
        shutil.copyfile(ROOT/('.tmp/codex61_'+name+'.py'),repro/('codex61_'+name+'.py'))
    shutil.copyfile(BASE/'metadata-table-schemas.json',repro/'metadata-table-schemas.json')
    proofs=DEST/'proofs';proofs.mkdir();shutil.copyfile(BASE/'proxy-proof/proof.json',proofs/'proxy-adversarial.json')
    for c in ['A','B']:
        dst=proofs/c;dst.mkdir()
        for name in ['hooks.json','skills.json','mcp.json','production-path-denial.json']:
            shutil.copyfile(BASE/('final-proof-'+c)/name,dst/name)
    shutil.copyfile(BASE/'final-proof-A/actual-rule-hook-stdout.json',proofs/'actual-shipped-core-hook-output.json')
    verified={}
    for c in ['A','B']:
        h=hashlib.sha256()
        with gzip.open(DEST/c/'events.jsonl.gz','rb') as f:
            while chunk:=f.read(1024*1024):h.update(chunk)
        assert h.hexdigest()==raw[c]['uncompressed_sha256'];verified[c]=True
    (DEST/'archive-verification.json').write_text(json.dumps({'raw_roundtrip_sha256':verified,'no_homes_auth_runtime_private_forensics_copied':True},indent=2))
    print('ARCHIVED',DEST);print(json.dumps(summary,ensure_ascii=False))
if __name__=='__main__':main()

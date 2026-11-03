"""One journal per invocation. Export public actions and numeric facts only."""
import sys,json,re,hashlib,bisect
from pathlib import Path

source,target=map(Path,sys.argv[1:])
calls={};children={};responses=[];hook_starts={};hooks=[];compactions=[]
generation=1
def text_blocks(value):
    if isinstance(value,str):return value
    if isinstance(value,list):return '\n'.join(x.get('text','') for x in value if isinstance(x,dict) and isinstance(x.get('text'),str))
    return ''
def tables(obj):
    out=[]
    if isinstance(obj,dict):
        if isinstance(obj.get('columns'),list) and isinstance(obj.get('rows'),list):
            for row in obj['rows']:
                if isinstance(row,list):out.append(dict(zip(obj['columns'],row)))
        for k,v in obj.items():
            if k not in ['columns','rows']:out.extend(tables(v))
    elif isinstance(obj,list):
        for v in obj:out.extend(tables(v))
    return out
def facts(obj):
    result=[]
    def visit(v):
        if isinstance(v,dict):
            p=v.get('payload',v)
            if isinstance(p,dict) and p.get('relativePath'):
                body=p.get('content');result.append({'path':p['relativePath'],'symbol':p.get('symbolId'),'start':p.get('startLine'),'end':p.get('endLine'),'body_chars':len(body) if isinstance(body,str) else 0,'body_sha256':hashlib.sha256(body.encode()).hexdigest() if isinstance(body,str) else None})
            for k,x in v.items():
                if k not in ['content','payload']:visit(x)
        elif isinstance(v,list):
            for x in v:visit(x)
    visit(obj)
    for row in tables(obj):
        result.append({'path':row.get('payload.relativePath',row.get('relativePath')),'symbol':row.get('payload.symbolId',row.get('symbolId')),'start':row.get('payload.startLine'),'end':row.get('payload.endLine'),'body_chars':len(row.get('payload.content','')) if isinstance(row.get('payload.content'),str) else 0,'body_sha256':hashlib.sha256(row['payload.content'].encode()).hexdigest() if isinstance(row.get('payload.content'),str) else None})
    return result
for line in source.open():
    e=json.loads(line);m=e.get('method','');p=e.get('params',{});i=p.get('item',{});ts=e.get('emittedAtMs')
    if m=='rawResponse/completed':responses.append({'wave':generation,'id':p.get('responseId'),'ms':ts});generation+=1
    if 'compact' in m.lower():compactions.append({'method':m,'ms':ts})
    if m=='rawResponseItem/completed':
        kind=i.get('type')
        if kind in ['custom_tool_call','function_call']:
            code=i.get('input',i.get('arguments',''));calls[i['call_id']]={'id':i['call_id'],'wave':generation,'name':i.get('name'),'start_ms':ts,'code':code,'schema_introspection':bool(re.search(r'ALL_TOOLS|exec tool declaration|description[.]split',code))}
        elif kind in ['custom_tool_call_output','function_call_output']:
            c=calls.setdefault(i['call_id'],{'id':i['call_id']});body=text_blocks(i.get('output',[]));c.update(end_ms=ts,output_chars=len(body),output_truncated=bool(re.search(r'\d+ tokens truncated|Token budget exceeded|omitted.*bytes',body)))
    if m in ['item/started','item/completed'] and i.get('type') in ['commandExecution','mcpToolCall']:
        c=children.setdefault(i['id'],{'id':i['id'],'type':i['type']});c['start_ms' if m.endswith('started') else 'end_ms']=i.get('startedAtMs' if m.endswith('started') else 'completedAtMs') or p.get('startedAtMs' if m.endswith('started') else 'completedAtMs') or ts
        if m.endswith('completed'):
            c.update(status=i.get('status'),duration_ms=i.get('durationMs'))
            if i['type']=='commandExecution':
                cmd=i.get('command') or '';output=i.get('aggregatedOutput') or '';c.update(command=cmd,exit_code=i.get('exitCode'),output_unknown=i.get('aggregatedOutput') is None,output_chars=len(output),output_truncated=bool(re.search(r'\d+ tokens truncated|Token budget exceeded',output)),skill_read='SKILL.md' in cmd,instruction_read=bool(re.search(r'SKILL[.]md|/references/|tea-rags://guide/',cmd)))
            else:
                result=i.get('result') or {};sc=result.get('structuredContent') or {};c.update(tool=i.get('tool'),arguments=i.get('arguments'),error=i.get('error'),result_facts=facts(sc),result_top_keys=list(sc) if isinstance(sc,dict) else [],banner=sc.get('banner') if isinstance(sc,dict) else None)
                if isinstance(sc,dict):
                    for key in ['empty','truncated','workingTree']:
                        if key in sc:c[key]=sc[key]
    if m=='hook/started':hook_starts[p['run']['id']]=ts
    if m=='hook/completed':
        run=p['run'];hooks.append({'id':run['id'],'event':run.get('eventName'),'start_ms':hook_starts.get(run['id']),'end_ms':ts,'duration_ms':run.get('durationMs'),'status':run.get('status'),'entries':run.get('entries')})
for c in children.values():
    candidates=[x for x in calls.values() if x.get('start_ms',10**20)<=c.get('start_ms',0) and c.get('end_ms',10**20)<=x.get('end_ms',0)]
    if candidates:
        parent=min(candidates,key=lambda x:x['end_ms']-x['start_ms']);c['wave']=parent['wave'];c['outer_id']=parent['id']
    else:c['wave']=None
waves=[]
for r in responses:
    cs=[x for x in calls.values() if x.get('wave')==r['wave']];ch=[x for x in children.values() if x.get('wave')==r['wave']]
    source_work=[x for x in ch if x['type']=='mcpToolCall' or (x['type']=='commandExecution' and not x['instruction_read'])]
    waves.append({**r,'outer_calls':cs,'children':ch,'instruction_only':bool(ch) and not source_work,'schema_introspection':any(x.get('schema_introspection') for x in cs)})
out={'source':str(source),'source_journal_sha256':hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest(),'waves':waves,'hooks':hooks,'compactions':compactions,'limits':['Native result bodies are represented only by hashes/locators; no reasoning fields exported.','Outer output truncation prevents treating every native body as delivered; inspect public outer outputs where needed.','No response scheduling saving inferred solely from native tool count.']}
target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'path':str(target),'responses':len(responses),'instruction_only_waves':[x['wave'] for x in waves if x['instruction_only']],'introspection_waves':[x['wave'] for x in waves if x['schema_introspection']],'compactions':len(compactions)}))

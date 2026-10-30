"""Offline captured-response preservation checks. No upstream or model calls."""
import copy
import hashlib
import json
from pathlib import Path
import codex61_mcp_proxy as p

BASE=Path(__file__).with_name('codex61');SHAPES=BASE/'private/shapes'
manifest=json.loads((SHAPES/'manifest.json').read_text());schemas=set()
def tables(v):
    if isinstance(v,dict):
        if isinstance(v.get('columns'),list) and isinstance(v.get('rows'),list):
            yield v
        for x in v.values():yield from tables(x)
    elif isinstance(v,list):
        for x in v:yield from tables(x)
def decoded_payloads(msg):
    r=msg['result'];out=[]
    if 'structuredContent' in r:out.append(r['structuredContent'])
    for b in r.get('content',[]):
        if b.get('type')=='text':
            try:v,_=json.JSONDecoder().raw_decode(b['text'].lstrip());out.append(v)
            except ValueError:pass
    return out
for x in manifest:
    if 'tool' not in x:continue
    raw=json.loads((SHAPES/(x['tool']+'.json')).read_text())
    for v in decoded_payloads(raw):
        for t in tables(v):schemas.add(tuple(t['columns']))
(BASE/'metadata-table-schemas.json').write_text(json.dumps(sorted(schemas),indent=2))
p.METADATA_TABLES=schemas
checks=[]
for x in manifest:
    if 'tool' in x:
        name=x['tool'];assert name in p.READ_TOOLS
        raw=json.loads((SHAPES/(name+'.json')).read_text())
        assert not raw.get('error') and not raw['result'].get('isError'),name+' invalid positive fixture'
        req={'method':'tools/call','params':{'name':name,'arguments':x['arguments']}}
        filtered=p.filtered_response(raw,req)
        before=[len(t['rows']) for v in decoded_payloads(raw) for t in tables(v)]
        after=[len(t['rows']) for v in decoded_payloads(filtered) for t in tables(v)]
        assert before==after,(name,before,after)
        if name=='find_symbol':assert raw['result']['structuredContent']==filtered['result']['structuredContent']
        if name=='search_code':assert raw['result']['content']==filtered['result']['content']
        checks.append({'tool':name,'passed':True,'table_rows_before':before,'table_rows_after':after,
            'raw_sha256':hashlib.sha256((SHAPES/(name+'.json')).read_bytes()).hexdigest()})
    else:
        raw=json.loads((SHAPES/x['file']).read_text())
        f=p.filtered_response(raw,{'method':'resources/read','params':{'uri':x['resource']}})
        assert raw['result']['contents']==f['result']['contents']
        checks.append({'resource':x['resource'],'byte_identical_text':True})
assert len([x for x in checks if 'tool' in x])==17
project={'name':p.PROJECT,'path':p.REPO,'env':{'SECRET':'CANARY'},'collectionName':p.COLLECTION}
for shape in [[project],{'projects':[project]},{'projects':{'columns':['name','path','env'],'rows':[[p.PROJECT,p.REPO,{'SECRET':'CANARY'}]]}}]:
    assert 'CANARY' not in json.dumps(p.project_result(shape))
for tool in p.READ_TOOLS:
    if tool=='search_code':bad='Found 1 result(s):\n\n--- Result 1 (score: 0.500) ---\nFile: docs/leak.rb:1-3\nLanguage: ruby\n\nCANARY'
    else:bad='CANARY_UNCLASSIFIED'
    try:p.parse_tool_text(bad,tool,{})
    except ValueError:pass
    else:raise AssertionError('Unlocated plaintext accepted '+tool)
checks.append({'negative_plaintext_all_17':True,'project_list_dict_table_shapes':True})
(BASE/'fixture-proof.json').write_text(json.dumps({'checks':checks,'all_passed':True},indent=2))
print('PASS:17 actual successful tool shapes,2 resource bodies,all table row counts preserved; project3shapes and plaintext17 negatives')

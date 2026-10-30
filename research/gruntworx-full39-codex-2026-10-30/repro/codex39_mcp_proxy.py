#!/usr/bin/env python3
"""Read-only corpus boundary around the unchanged shipped MCP stdio server.

Configuration path is supplied by trusted launch environment, never model input.
Transport wrapper does not answer code questions or augment returned source.
"""
import copy
import json
import os
from pathlib import Path,PurePosixPath
import sys
import threading
import subprocess
import re
from urllib.parse import unquote,urlsplit,parse_qs

REPO='/Users/Shared/nav-ab/repo-master'
PROJECT='taxdome-worktree-navmaster'
COLLECTION='code_b6533d3e'
READ_TOOLS={'find_symbol','semantic_search','hybrid_search','search_code','find_similar',
 'rank_chunks','get_callers','get_callees','trace_path','find_cycles','find_co_changed',
 'get_architecture_report','get_naming_lexicon','get_ontology_report','get_index_status',
 'get_index_metrics','list_projects'}
FORBIDDEN={'docs','specs','.git','.agents','.codex','.claude'}

def decoded(s):
    old=None
    for _ in range(4):
        if old==s:break
        old=s;s=unquote(s)
    return s.replace('\\','/')

def safe_path(value,glob=False):
    s=decoded(str(value))
    if '\x00' in s or '%' in s:return False
    parts=PurePosixPath(s).parts
    if '..' in parts:return False
    if any(p.lower() in FORBIDDEN for p in parts):return False
    if s.lower().endswith(('.md','.markdown','.mdx')):return False
    # Resolve concrete relative locators too: a source-looking symlink is not
    # an authorization to read its outside/docs target. For a glob, resolve
    # its concrete prefix and retain the lexical checks above.
    concrete=s
    if glob:
        prefix=[]
        for part in PurePosixPath(s).parts:
            if any(c in part for c in '*?['):break
            prefix.append(part)
        concrete=str(PurePosixPath(*prefix)) if prefix else '.'
    p=Path(concrete)
    if not p.is_absolute():p=Path(REPO)/p
    try:resolved=p.resolve().relative_to(REPO)
    except (ValueError,OSError):return False
    if any(part.lower() in FORBIDDEN for part in resolved.parts):return False
    if str(resolved).lower().endswith(('.md','.markdown','.mdx')):return False
    return True

def safe_resource(uri):
    s=decoded(uri)
    if '%' in s or '..' in s or '#' in s:return False
    if re.fullmatch(r'tea-rags://(?:guide|schema)/[a-z0-9][a-z0-9/_-]*',s):return True
    if s=='tea-rags://project/'+PROJECT+'/digest':return True
    base='tea-rags://project/'+PROJECT+'/metrics'
    if not s.startswith(base+'?'):return False
    query=parse_qs(urlsplit(s).query,strict_parsing=True)
    return set(query)<= {'language','section'} and all(len(v)==1 for v in query.values()) and \
        re.fullmatch(r'[A-Za-z][A-Za-z0-9_+-]{0,30}',query.get('language',[''])[0]) is not None and \
        query.get('section',['thresholds'])==['thresholds']

def guard_call(name,args):
    if name not in READ_TOOLS:raise ValueError('Tool is not exposed in this read-only benchmark')
    a=copy.deepcopy(args)
    for key in ['project','collection','path']:
        if key in a:
            expected={'project':PROJECT,'collection':COLLECTION,'path':REPO}[key]
            if a[key]!=expected:raise ValueError('Cross-corpus '+key+' is blocked')
    # Collection mode drops working-tree addressing and is intentionally unavailable.
    if 'collection' in a:raise ValueError('Raw collection addressing is blocked')
    if name!='list_projects':a.update(project=PROJECT,path=REPO)
    else:a={'project':PROJECT}
    def walk(x,key=''):
        if isinstance(x,dict):
            for k,v in x.items():
                if k.lower() in {'collection','collectionname','project'} and v not in [PROJECT,COLLECTION]:
                    raise ValueError('Nested corpus selector is blocked')
                walk(v,k)
        elif isinstance(x,list):
            for v in x:walk(v,key)
        elif isinstance(x,str):
            if x.startswith('doc:'):raise ValueError('Document symbol ids are blocked')
            path_key=key in {'path','relativePath','fromPath','toPath','filePath','files','affectedFiles','sourceRelPath','targetRelPath','pathPattern'}
            identifier_path=key in {'symbols','symbol','symbolId'} and ('/' in x or x.lower().endswith(('.md','.markdown','.mdx')))
            if path_key or identifier_path:
                if not safe_path(x,glob=key=='pathPattern'):raise ValueError('Documentation, history or traversal path is blocked')
    walk(a)
    # A path-bearing locator must always accompany returned content for output filtering.
    if isinstance(a.get('fields'),list):
        a['fields']=list(dict.fromkeys(a['fields']+['relativePath']))
    if name in {'semantic_search','hybrid_search','search_code'}:
        a['documentation']='exclude'
    return a

def clean(value):
    """Drop forbidden result rows before any response is returned to the model."""
    if isinstance(value,list):
        return [x for item in value if (x:=clean(item)) is not None]
    if not isinstance(value,dict):return value
    locators={'relativePath','relPath','payload.relativePath','payload.relPath','filePath','path','tree','sourceRelPath','targetRelPath'}
    body_keys={'content','text','body','sourceText','importText','snippet','code','preview'}
    if any(k in value for k in body_keys) and not any(isinstance(value.get(k),str) and safe_path(value[k]) for k in locators):
        return None
    for key in locators:
        if isinstance(value.get(key),str) and not safe_path(value[key]):return None
    if isinstance(value.get('payload'),dict):
        p=value['payload']
        if p.get('chunkType')=='documentation' or str(p.get('symbolId','')).startswith('doc:'):return None
    if isinstance(value.get('columns'),list) and isinstance(value.get('rows'),list):
        cols=value['columns']; indices=[i for i,k in enumerate(cols) if k in locators]
        rows=[]
        for row in value['rows']:
            if not indices:
                safe_metadata={'id','score','name','kind','symbolId','count','fileCount','usageCount','declarationCount',
                    'frequency','verdict','reason','label','value','percentile','metric','type','language'}
                if not set(cols)<=safe_metadata:continue
                rows.append(row);continue
            if all(i<len(row) and isinstance(row[i],str) and safe_path(row[i]) for i in indices):rows.append(row)
        return {**value,'rows':rows}
    return {k:v2 for k,v in value.items() if k!='_meta' and (v2:=clean(v)) is not None}

def filtered_response(message,request):
    out=copy.deepcopy(message)
    if 'error' in out:
        out['error']={'code':-32001,'message':'Scoped upstream request failed'}
        return out
    method=request.get('method')
    if method=='tools/list':
        out['result']['tools']=[t for t in out.get('result',{}).get('tools',[]) if t.get('name') in READ_TOOLS]
        return out
    if method=='resources/list':
        out['result']['resources']=[r for r in out.get('result',{}).get('resources',[]) if safe_resource(r.get('uri',''))]
        return out
    if method=='resources/templates/list':
        # Project templates can name arbitrary aliases; expose only non-project guides/schema.
        out['result']['resourceTemplates']=[r for r in out.get('result',{}).get('resourceTemplates',[])
            if r.get('uriTemplate','').startswith(('tea-rags://guide/','tea-rags://schema/'))]
        return out
    result=out.get('result')
    if not isinstance(result,dict):return out
    if result.get('isError'):
        out['result']={'isError':True,'content':[{'type':'text','text':'[BENCH_READ_ERROR] Scoped upstream read failed.'}]}
        return out
    if method=='tools/call' and request.get('params',{}).get('name')=='list_projects':
        for block in result.get('content',[]):
            if block.get('type')=='text':
                d=json.loads(block['text']); p=d.get('projects',{}); cols=p.get('columns',[])
                if 'name' in cols and 'path' in cols:
                    ni=cols.index('name');pi=cols.index('path')
                    p['rows']=[r for r in p.get('rows',[]) if r[ni]==PROJECT and r[pi]==REPO]
                else:p={'columns':[],'rows':[]}
                # Omit all other registry/config metadata, including global embedding/account data.
                block['text']=json.dumps({'projects':p},ensure_ascii=False)
        result.pop('structuredContent',None)
        result.pop('_meta',None)
        result['content']=[b for b in result.get('content',[]) if b.get('type')=='text']
        return out
    if method=='tools/call':
        if 'structuredContent' in result:
            if not isinstance(result['structuredContent'],(dict,list)):raise ValueError('Scalar tool result blocked')
            if isinstance(result['structuredContent'],list) and not all(isinstance(x,dict) for x in result['structuredContent']):raise ValueError('Unclassified tool list blocked')
            result['structuredContent']=clean(result['structuredContent'])
            # Structured payload is canonical; discard duplicated unclassified text blocks.
            result['content']=[]
        else:
            result['content']=[b for b in result.get('content',[]) if b.get('type')=='text']
            for block in result.get('content',[]):
                if block.get('type')=='text':
                    try:
                        parsed=json.loads(block['text'])
                        if not isinstance(parsed,(dict,list)):raise ValueError('Scalar tool result blocked')
                        if isinstance(parsed,list) and not all(isinstance(x,dict) for x in parsed):raise ValueError('Unclassified tool list blocked')
                        block['text']=json.dumps(clean(parsed),ensure_ascii=False)
                    except (ValueError,TypeError):
                        raise ValueError('Unclassified text tool result blocked')
        result.pop('_meta',None)
    elif method=='resources/read':
        uri=request.get('params',{}).get('uri','')
        if not safe_resource(uri):raise ValueError('Resource response outside scope')
        contents=[]
        for block in result.get('contents',[]):
            if block.get('uri')!=uri or not isinstance(block.get('text'),str):raise ValueError('Unclassified resource response')
            # Only the explicitly scoped URI's canonical text crosses the boundary.
            contents.append({'uri':uri,'mimeType':block.get('mimeType','text/plain'),'text':block['text']})
        out['result']={'contents':contents}
    return out

def main():
    cfg=json.loads(Path(os.environ['BENCH_MCP_PROXY_CONFIG']).read_text())
    env={**os.environ,**cfg['upstream_env']}
    log=Path(cfg['audit_log']);log.parent.mkdir(exist_ok=True,parents=True)
    audit=log.open('a'); lock=threading.Lock();requests={}
    stderr_log=Path(cfg['upstream_stderr_log']).open('a')
    upstream=subprocess.Popen(cfg['upstream_command'],cwd=REPO,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr_log,text=True,bufsize=1)
    def event(kind,**values):
        with lock:audit.write(json.dumps({'kind':kind,**values},ensure_ascii=False)+'\n');audit.flush()
    def reply(obj):
        with lock:sys.stdout.write(json.dumps(obj,ensure_ascii=False)+'\n');sys.stdout.flush()
    def reader():
        for line in upstream.stdout:
            try:
                msg=json.loads(line)
                if 'method' in msg and 'id' in msg:
                    # No upstream server-initiated tools or elicitation can escape approval policy.
                    upstream.stdin.write(json.dumps({'jsonrpc':'2.0','id':msg['id'],'error':{'code':-32000,'message':'Server request disabled in benchmark'}})+'\n');upstream.stdin.flush();continue
                elif 'method' in msg:
                    # No unsolicited server logs/resources can become model context.
                    event('dropped_notification',method=msg.get('method'));continue
                req=requests.pop(str(msg.get('id')),None)
                if not req:
                    event('dropped_unmatched_response');continue
                msg=filtered_response(msg,req)
                if req.get('method')=='tools/call':event('tool_response',id=msg.get('id'),name=req.get('params',{}).get('name'),is_error=bool(msg.get('error') or msg.get('result',{}).get('isError')))
                reply(msg)
            except Exception as e:
                event('blocked_response',reason=str(e))
                if 'msg' in locals() and 'id' in msg:reply({'jsonrpc':'2.0','id':msg['id'],'error':{'code':-32001,'message':'Corpus boundary rejected response'}})
        event('upstream_closed',returncode=upstream.poll())
    threading.Thread(target=reader,daemon=True).start()
    try:
        for line in sys.stdin:
            msg=json.loads(line); original=copy.deepcopy(msg)
            try:
                method=msg.get('method','')
                if method=='tools/call':
                    p=msg.get('params',{});p['arguments']=guard_call(p.get('name'),p.get('arguments',{}))
                    event('tool_request',id=msg.get('id'),name=p.get('name'),arguments=p['arguments'])
                elif method=='resources/read':
                    if not safe_resource(msg.get('params',{}).get('uri','')):raise ValueError('Resource outside safe target scope')
                elif method not in {'initialize','notifications/initialized','ping','tools/list','resources/list','resources/templates/list','notifications/cancelled'}:
                    raise ValueError('Protocol method disabled')
                if 'id' in msg:requests[str(msg['id'])]=original
                upstream.stdin.write(json.dumps(msg,ensure_ascii=False)+'\n');upstream.stdin.flush()
            except Exception as e:
                event('blocked_request',method=msg.get('method'),reason=str(e))
                if 'id' in msg:reply({'jsonrpc':'2.0','id':msg['id'],'error':{'code':-32001,'message':str(e)}})
    finally:
        upstream.terminate()
        try:upstream.wait(timeout=10)
        except subprocess.TimeoutExpired:upstream.kill()
        audit.close()
        stderr_log.close()

if __name__=='__main__':main()

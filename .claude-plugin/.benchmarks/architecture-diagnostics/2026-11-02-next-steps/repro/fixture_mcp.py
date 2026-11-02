#!/usr/bin/env python3
"""Deterministic, fixture-only stdio MCP service for routing evaluations.

Copied from search-cascade/2026-10-31-4mffb/repro; adds find_co_changed, the
restructurePlan raw-response key, and norms/files/restructurePlan props."""
import argparse
import json
import re
import sys
import time
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', required=True)
    parser.add_argument('--audit', required=True)
    parser.add_argument('--plugin-root')
    opts = parser.parse_args()
    source = json.loads(Path(opts.fixture).read_text())
    # Explicit allowlist: grading and expected fields are never served.
    data = {k: source[k] for k in ('cwd', 'alias', 'files', 'raw_tool_responses',
            'find_symbol_bodies', 'architecture_report', 'metrics') if k in source}
    files = data.get('files', {})
    alias, cwd = data.get('alias', 'read-batch-fixture'), data.get('cwd', '')
    guides = {}
    if opts.plugin_root:
        directory = Path(opts.plugin_root) / 'rules' / 'guides'
        guides = {p.stem: p.read_text() for p in directory.glob('*.md') if p.is_file()}
    tool_names = ('find_symbol', 'semantic_search', 'hybrid_search', 'get_callees',
                  'get_callers', 'get_architecture_report', 'get_index_metrics',
                  'list_projects', 'rank_chunks', 'resolve_metrics', 'find_co_changed')
    props = {k: {'type': 'string'} for k in ('project', 'path', 'relativePath',
             'symbol', 'symbolId', 'query', 'pathPattern', 'rerank')}
    props.update(symbols={'type': 'array', 'items': {'type': 'string'}},
                 metaOnly={'type': 'boolean'}, limit={'type': 'integer'},
                 depth={'type': 'integer'}, restructure={'type': 'object'},
                 restructurePlan={'type': 'object'}, norms={'type': 'boolean'},
                 files={'type': 'array', 'items': {'type': 'string'}},
                 filter={'type': 'object', 'description': 'Raw Qdrant filter (must/should/must_not) on payload keys.'},
                 fields={'type': 'array', 'items': {'type': 'string'}},
                 scope={'type': 'string', 'enum': ['code', 'migrations'],
                        'description': 'Default code. Use migrations for Rails schema history (not current state); ranks by relevance and ignores signal rerank presets.'})

    def audit(event, request, **extra):
        entry = dict(event=event, timestamp_ns=time.time_ns(),
                     monotonic_ns=time.monotonic_ns(), request_id=request.get('id'),
                     method=request.get('method'), **extra)
        with open(opts.audit, 'a') as out:
            out.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def relative(path):
        if path.startswith(cwd.rstrip('/') + '/') and cwd:
            path = path[len(cwd.rstrip('/')) + 1:]
        normalized = PurePosixPath(path)
        return str(normalized) if not normalized.is_absolute() and '..' not in normalized.parts else ''

    def payload(path, symbol, text, start=1, end=None):
        return dict(relativePath=path, symbolId=symbol, startLine=start,
                    endLine=end or max(start, start + len(text.splitlines()) - 1), content=text)

    bodies = {}
    for symbol, entry in data.get('find_symbol_bodies', {}).items():
        if isinstance(entry, str):
            bodies[symbol] = payload('', symbol, entry)
        else:
            entry = entry.get('payload', entry)
            bodies[symbol] = payload(entry.get('relativePath', ''), symbol,
                entry.get('body', entry.get('content', '')), entry.get('startLine', 1), entry.get('endLine'))

    def file_symbols(path):
        lines, entries, owner = files[path].splitlines(), [], ''
        if path.endswith(('.ts', '.tsx', '.js')):
            def span(start):
                depth = 0
                for end in range(start, len(lines)):
                    depth += lines[end].count('{') - lines[end].count('}')
                    if depth <= 0:
                        return end + 1
                return len(lines)
            for index, line in enumerate(lines):
                declaration = re.match(r'\s*(?:export\s+)?(?:abstract\s+)?(class|interface)\s+(\w+)', line)
                if declaration:
                    owner = declaration.group(2)
                    end = span(index)
                    entry = payload(path, owner, '\n'.join(lines[index:end]), index + 1, end)
                    entry['kind'] = declaration.group(1)
                    entries.append(entry)
                method = re.match(r'\s+(?:(?:public|private|protected|async|static|readonly)\s+)*(\w+)\s*\(', line)
                if method and owner and method.group(1) not in ('if', 'for', 'while', 'switch', 'catch'):
                    end = span(index)
                    sep = '.' if re.search(r'\bstatic\b', line[:line.index('(')]) else '#'
                    entries.append(payload(path, owner + sep + method.group(1), '\n'.join(lines[index:end]), index + 1, end))
            return entries
        starts, stack, headers = [], [], []
        for index, line in enumerate(lines):
            indent = len(line) - len(line.lstrip())
            match = re.match(r'\s*(class|module)\s+([\w:]+)', line)
            if match:
                name = '::'.join([n for _, n in stack] + [match.group(2)])
                stack.append((indent, name))
                if match.group(1) == 'class':
                    headers.append([index, name, None])
                continue
            if re.match(r'\s*end\s*$', line) and stack and stack[-1][0] == indent:
                stack.pop()
                continue
            owner = stack[-1][1] if stack else ''
            method = re.match(r'\s*def\s+(self\.)?([\w?!]+)', line)
            if method:
                symbol = (owner + ('.' if method.group(1) else '#') if owner else '') + method.group(2)
                starts.append((index, symbol))
                for header in headers:
                    if header[1] == owner and header[2] is None:
                        header[2] = index
        for index, (start, symbol) in enumerate(starts):
            end = starts[index + 1][0] if index + 1 < len(starts) else len(lines)
            entries.append(payload(path, symbol, '\n'.join(lines[start:end]), start + 1, end))
        for start, name, first_def in headers:
            stop = first_def if first_def is not None else len(lines)
            text = '\n'.join(lines[start:stop]).rstrip()
            entry = payload(path, name, text, start + 1, start + len(text.splitlines()))
            entry['kind'] = 'class'
            entries.append(entry)
        return entries

    for path in files:
        for entry in file_symbols(path):
            bodies.setdefault(entry['symbolId'], entry)

    def table(entries, meta=False):
        keys = ['relativePath', 'symbolId', 'startLine', 'endLine'] + ([] if meta else ['content'])
        return {'workingTree': {'project': alias, 'tree': cwd},
                'results': {'columns': ['payload.' + k for k in keys],
                            'rows': [[entry.get(k) for k in keys] for entry in entries]},
                'count': len(entries)}

    def raw_response(name, args):
        raw = data.get('raw_tool_responses', {})
        if isinstance(raw, list):
            for item in raw:
                wanted = item.get('arguments', {})
                if item.get('symbol'):
                    wanted = dict(wanted, symbol=item['symbol'])
                def matches(key, value):
                    return args.get(key) == value or (key == 'symbol' and args.get('symbols') == [value])
                if item.get('tool') == name and all(matches(k, v) for k, v in wanted.items()):
                    return item.get('result')
        else:
            keys = ([name + '.restructurePlan'] if args.get('restructurePlan') else [])
            keys += ([name + '.restructure'] if args.get('restructure') else [])
            keys += [name + ':' + str(args.get('symbol', args.get('relativePath', ''))), name]
            for key in keys:
                if key in raw:
                    return raw[key]
        return None

    OPS = ('create_table', 'drop_table', 'rename_table', 'add_column', 'remove_column', 'rename_column',
           'change_column', 'change_column_null', 'change_column_default', 'add_index', 'remove_index',
           'rename_index', 'add_reference', 'remove_reference', 'add_foreign_key', 'remove_foreign_key', 'execute')

    def migration_rows():
        rows = []
        for path in sorted(p for p in files if p.startswith('db/migrate/') and p.endswith('.rb')):
            version = PurePosixPath(path).name.split('_', 1)[0]
            lines, safety, block = files[path].splitlines(), None, None
            for index, line in enumerate(lines):
                indent = len(line) - len(line.lstrip())
                if re.match(r'\s*safety_assured\s+do\b', line):
                    safety = indent
                    continue
                if safety is not None and re.match(r'\s*end\s*$', line) and indent == safety:
                    safety = None
                    continue
                if block is not None:
                    col = re.match(r'\s*t\.(\w+)\s+:(\w+)', line)
                    if col:
                        block['columns'].append(col.group(2))
                    if re.match(r'\s*end\s*$', line) and indent == block['indent']:
                        block = None
                    continue
                op = re.match(r'\s*(' + '|'.join(OPS) + r')\b\s*(.*)', line)
                if not op:
                    continue
                verb, rest = op.group(1), op.group(2)
                target = re.match(r':(\w+)', rest)
                table_name = target.group(1) if target and verb != 'execute' and safety is None else None
                after = rest[target.end():] if target else rest
                columns = []
                if verb == 'add_index':
                    listed = re.match(r'\s*,\s*(?:%i\[([^\]]*)\]|\[([^\]]*)\]|:(\w+))', after)
                    if listed:
                        columns = (listed.group(1) or '').split() or re.findall(r'(\w+)', listed.group(2) or '') or [listed.group(3)]
                elif verb == 'rename_index':
                    columns = re.findall(r"'([^']+)'", ' '.join(lines[index:index + 3]))[:1]
                elif verb in ('add_column', 'remove_column', 'rename_column', 'add_reference', 'remove_reference',
                              'change_column', 'change_column_null', 'change_column_default'):
                    second = re.match(r'\s*,\s*:(\w+)', after)
                    columns = [second.group(1)] if second else []
                row = {'relativePath': path, 'operation': verb, 'table': table_name, 'columns': columns,
                       'version': version, 'direction': 'change', 'startLine': index + 1, 'endLine': index + 1,
                       'content': line.strip()}
                rows.append(row)
                if verb == 'create_table' and re.search(r'\bdo\b', line):
                    block = {'indent': indent, 'columns': row['columns']}
        return rows

    def migration_search(args):
        rows = migration_rows()
        filt = args.get('filter') or {}
        if isinstance(filt, str):
            filt = json.loads(filt)
        for cond in filt.get('must', []):
            key = str(cond.get('key', '')).replace('payload.', '')
            value = (cond.get('match') or {}).get('value')
            if key and value is not None:
                rows = [r for r in rows if r.get(key) == value]
        tokens = re.findall(r'[a-z0-9_]+', str(args.get('query', '')).lower())
        rows.sort(key=lambda r: -sum(t in (r['relativePath'] + ' ' + r['content'] + ' ' + str(r['table'])).lower() for t in tokens))
        limit = max(0, min(int(args.get('limit', 10) or 10), 100))
        keys = ['relativePath', 'operation', 'table', 'columns', 'version', 'startLine', 'endLine'] + ([] if args.get('metaOnly') else ['content'])
        picked = rows[:limit]
        return {'workingTree': {'project': alias, 'tree': cwd},
                'results': {'columns': ['payload.' + k for k in keys],
                            'rows': [[r.get(k) for k in keys] for r in picked]},
                'count': len(picked)}

    def call(name, args):
        override = raw_response(name, args)
        if override is not None:
            return override
        if name == 'find_symbol':
            symbols = args.get('symbols') or ([args['symbol']] if args.get('symbol') else [])
            if symbols:
                entries, missing, outline = [], [], False
                headers = []
                for symbol in symbols:
                    if symbol not in bodies:
                        partial = [k for k in bodies if k.endswith('::' + symbol.lstrip(':'))]
                        if len(partial) == 1:
                            symbol = partial[0]
                    if symbol in bodies:
                        entry = bodies[symbol]
                        if entry.get('kind') == 'class':
                            if entry['relativePath'].endswith('.rb'):
                                headers.append({k: entry[k] for k in ('symbolId', 'relativePath', 'startLine', 'endLine', 'content')})
                                entries.extend(v for k, v in bodies.items() if k.startswith((symbol + '#', symbol + '.')))
                            else:
                                entries.extend(v for k, v in bodies.items() if k == symbol or k.startswith((symbol + '#', symbol + '.')))
                            outline = True
                        else:
                            entries.append(entry)
                    elif relative(symbol) in files:
                        path = relative(symbol)
                        members = [v for v in bodies.values() if v['relativePath'] == path]
                        entries.extend(members or [payload(path, path, files[path])])
                        outline = bool(members) or outline
                    else:
                        missing.append(symbol)
                result = table(entries, outline or args.get('metaOnly', False))
                if outline:
                    result['kind'] = 'outline'
                if headers:
                    result['containerHeader'] = headers
                if missing:
                    result['empty'] = {'reason': 'unknownSymbol', 'missing': missing}
                return result
            path = relative(args.get('relativePath', ''))
            if path and any(p.startswith(path.rstrip('/') + '/') for p in files):
                return dict(table([v for v in bodies.values() if v['relativePath'].startswith(path.rstrip('/') + '/')], True), kind='outline')
            if path in files:
                entries = [v for v in bodies.values() if v['relativePath'] == path]
                if entries:
                    ruby_class = lambda v: v.get('kind') == 'class' and path.endswith('.rb')
                    heads = [{k: v[k] for k in ('symbolId', 'startLine', 'endLine', 'content')} for v in entries if ruby_class(v)]
                    result = dict(table([v for v in entries if not ruby_class(v)], True), kind='outline')
                    if heads:
                        result['containerHeader'] = heads
                    return result
                return table([payload(path, path, files[path])], args.get('metaOnly', False))
            return dict(table([]), empty={'reason': 'unknownPath', 'path': path})
        if name in ('semantic_search', 'hybrid_search') and args.get('scope') == 'migrations':
            return migration_search(args)
        if name in ('semantic_search', 'hybrid_search', 'rank_chunks'):
            query = args.get('query', '').lower()
            entries = list(bodies.values()) or [payload(p, p, text) for p, text in files.items()]
            tokens = re.findall(r'[a-z0-9_]+', query)
            entries.sort(key=lambda e: -sum(t in (e['symbolId'] + ' ' + e['content']).lower() for t in tokens))
            entries = [e for e in entries if not (e.get('kind') == 'class' and e['relativePath'].endswith('.rb'))]
            return table(entries[:max(0, min(args.get('limit', 5), 10))], True)
        if name == 'get_architecture_report':
            return data.get('architecture_report', {'empty': {'reason': 'noArchitectureFixture'}, 'violations': {}, 'rootCauses': []})
        if name in ('get_index_metrics', 'resolve_metrics'):
            return data.get('metrics', {'signals': {}, 'labelMap': {}, 'codegraph': {'status': 'ready'}, 'freshness': 'current'})
        if name == 'list_projects':
            return {'projects': [{'alias': alias, 'path': cwd, 'status': 'indexed'}]}
        if name in ('get_callees', 'get_callers'):
            return {'workingTree': {'project': alias, 'tree': cwd}, 'edges': [], 'empty': {'reason': 'noEdgeFixture'}}
        raise ValueError('Unknown tool: ' + name)

    def resource(uri):
        prefix = 'tea-rags://guide/'
        if uri.startswith(prefix) and uri[len(prefix):] in guides:
            return guides[uri[len(prefix):]]
        if uri.startswith('tea-rags://project/' + alias + '/metrics'):
            return json.dumps(data.get('metrics', {'signals': {}, 'labelMap': {}, 'freshness': 'current'}))
        if uri == 'tea-rags://project/' + alias + '/digest':
            return json.dumps({'project': alias, 'path': cwd, 'freshness': 'current'})
        raise ValueError('Unknown resource: ' + uri)

    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        if 'id' not in request:
            continue
        method, params = request.get('method'), request.get('params', {})
        audit('start', request, params=params)
        try:
            if method == 'initialize':
                result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'),
                          'capabilities': {'tools': {}, 'resources': {}},
                          'serverInfo': {'name': 'tea-rags-fixture', 'version': '1.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': [{'name': n, 'description': 'Deterministic fixture ' + n,
                          'inputSchema': {'type': 'object', 'properties': props, 'additionalProperties': True}} for n in tool_names]}
            elif method == 'tools/call':
                response = call(params['name'], params.get('arguments', {}))
                result = response if isinstance(response, dict) and 'content' in response else {
                    'content': [{'type': 'text', 'text': json.dumps(response, ensure_ascii=False)}],
                    'structuredContent': response if isinstance(response, dict) else {'result': response}}
            elif method == 'resources/list':
                uris = ['tea-rags://guide/' + k for k in sorted(guides)] + ['tea-rags://project/' + alias + '/metrics']
                result = {'resources': [{'uri': uri, 'name': uri.rsplit('/', 1)[-1], 'mimeType': 'text/plain'} for uri in uris]}
            elif method == 'resources/templates/list':
                result = {'resourceTemplates': []}
            elif method == 'resources/read':
                result = {'contents': [{'uri': params['uri'], 'mimeType': 'text/plain', 'text': resource(params['uri'])}]}
            else:
                raise ValueError('Unsupported method: ' + str(method))
            reply = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
            audit('end', request, status='ok')
        except Exception as error:
            reply = {'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32602, 'message': str(error)}}
            audit('end', request, status='error', error=str(error))
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()


def rep(old, new):
    global s
    assert old in s, old[:80]
    s = s.replace(old, new, 1)


rep("""                 depth={'type': 'integer'}, restructure={'type': 'object'})""", """                 depth={'type': 'integer'}, restructure={'type': 'object'},
                 filter={'type': 'object', 'description': 'Raw Qdrant filter (must/should/must_not) on payload keys.'},
                 fields={'type': 'array', 'items': {'type': 'string'}},
                 scope={'type': 'string', 'enum': ['code', 'migrations'],
                        'description': 'Default code. Use migrations for Rails schema history (not current state); ranks by relevance and ignores signal rerank presets.'})""")

old_ruby = s[s.index("        starts = []\n"):s.index("    for path in files:\n")]
new_ruby = r'''        starts, stack, headers = [], [], []
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

'''
s = s.replace(old_ruby, new_ruby)

rep("""                for symbol in symbols:
                    if symbol in bodies:""", """                headers = []
                for symbol in symbols:
                    if symbol not in bodies:
                        partial = [k for k in bodies if k.endswith('::' + symbol.lstrip(':'))]
                        if len(partial) == 1:
                            symbol = partial[0]
                    if symbol in bodies:""")
rep("""                        if entry.get('kind') == 'class':
                            entries.extend(v for k, v in bodies.items() if k == symbol or k.startswith((symbol + '#', symbol + '.')))
                            outline = True""", """                        if entry.get('kind') == 'class':
                            if entry['relativePath'].endswith('.rb'):
                                headers.append({k: entry[k] for k in ('symbolId', 'relativePath', 'startLine', 'endLine', 'content')})
                                entries.extend(v for k, v in bodies.items() if k.startswith((symbol + '#', symbol + '.')))
                            else:
                                entries.extend(v for k, v in bodies.items() if k == symbol or k.startswith((symbol + '#', symbol + '.')))
                            outline = True""")
rep("""                if outline:
                    result['kind'] = 'outline'
                if missing:""", """                if outline:
                    result['kind'] = 'outline'
                if headers:
                    result['containerHeader'] = headers
                if missing:""")
rep("""            if path in files:
                entries = [v for v in bodies.values() if v['relativePath'] == path]
                if entries:
                    return dict(table(entries, True), kind='outline')""", """            if path in files:
                entries = [v for v in bodies.values() if v['relativePath'] == path]
                if entries:
                    ruby_class = lambda v: v.get('kind') == 'class' and path.endswith('.rb')
                    heads = [{k: v[k] for k in ('symbolId', 'startLine', 'endLine', 'content')} for v in entries if ruby_class(v)]
                    result = dict(table([v for v in entries if not ruby_class(v)], True), kind='outline')
                    if heads:
                        result['containerHeader'] = heads
                    return result""")
rep("""        if name in ('semantic_search', 'hybrid_search', 'rank_chunks'):
            query""", """        if name in ('semantic_search', 'hybrid_search') and args.get('scope') == 'migrations':
            return migration_search(args)
        if name in ('semantic_search', 'hybrid_search', 'rank_chunks'):
            query""")
rep("""            return table(entries[:max(0, min(args.get('limit', 5), 5))], True)""", """            entries = [e for e in entries if not (e.get('kind') == 'class' and e['relativePath'].endswith('.rb'))]
            return table(entries[:max(0, min(args.get('limit', 5), 10))], True)""")

mig = r'''    OPS = ('create_table', 'drop_table', 'rename_table', 'add_column', 'remove_column', 'rename_column',
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

    def call(name, args):'''
rep("    def call(name, args):", mig)
p.write_text(s)
print("patched")

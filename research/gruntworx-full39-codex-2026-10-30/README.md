# Полный GruntWorx planning A/B: Codex, 39 вопросов

**Это не чистое причинное сравнение неизменённого плагина с baseline.** Обе реальные сессии завершили 39/39 вопросов, но isolation proxy в A отклонил пять ответов MCP: один раз с исключением list/dict и четыре раза как неклассифицированный текст. Поэтому измеренные время и токены достоверны для наблюдавшихся условий **A с isolation guard против B**, а всю разницу нельзя приписывать плагину. Повторов, исправлений действующих акторов и новых модельных запусков после обнаружения ограничения не было.

**Подтверждён один parser defect; для четырёх текстовых отклонений pre-filter payload не сохранён, поэтому корректность самих исходных ответов и необходимость отклонения остаются неизвестными.** Это не пять подтверждённых дефектов плагина.

## Наблюдавшиеся результаты

| Метрика | A: плагин .53.5 + MCP + isolation guard | B: без плагина/MCP/навыков |
|---|---:|---:|
| Завершённые вопросы / отдельные сессии | 39 / 1 | 39 / 1 |
| Session wall, секунды | 1164.439 | 312.069 |
| Сумма времени вопросов, секунды | 1110.188 | 262.704 |
| Сумма Q02–Q39, секунды | 1028.363 | 248.752 |
| Input tokens | 31,142,253 | 9,904,913 |
| Cached input, подмножество input | 30,543,744 | 9,717,888 |
| Output tokens, включая reasoning | 114,803 | 22,615 |
| Reasoning, подмножество output | 78,360 | 4,602 |
| Уникальные завершённые tool items | 282 | 64 |

В этой паре A занял **3.73×** session wall, **4.23×** суммы времени вопросов и **5.08×** output tokens. Без первого вопроса соотношение времени остаётся **4.13×**. Это описательные результаты одной последовательной пары A→B; повторов и статистической оценки устойчивости нет.

Session wall начинается после RPC initialize и заканчивается до teardown. Он включает thread startup и проверки неизменности между вопросами; поэтому отдельно приведена сумма времени самих вопросов. Cached input не следует прибавлять к input, reasoning — к output. Денежная стоимость здесь не оценивается.

Tool items A: shell96, metadata2, semantic39, resources25, source/graph120. В B — shell64. Все 39 завершений в каждом условии подтверждены native `turn/completed`; collector не обнаружил дубликатов, потерянных сопоставлений или некорректных JSON-строк. Наличие неиспользованных инструментов само по себе не считается ошибкой ответа.

## Ошибки транспорта и ограничения интерпретации

| Вопрос | Инструмент | Наблюдавшаяся причина proxy | Native duration, мс |
|---|---|---|---:|
| Q01 | `list_projects` | `'list' object has no attribute 'get'` | 12 |
| Q01 | `get_callees` | `Unclassified text tool result blocked` | 1260 |
| Q23 | `get_callees` | `Unclassified text tool result blocked` | 54 |
| Q26 | `get_index_status` | `Unclassified text tool result blocked` | 95 |
| Q27 | `get_callees` | `Unclassified text tool result blocked` | 53 |

Сумма сообщённых durations этих пяти вызовов — **1474 мс**. Это не оценка добавленной задержки: возможное восстановление, дополнительные запросы и reasoning после ошибок отдельно не измерены, и вычитать 1.474 с из session wall некорректно. Четыре текстовых отклонения нельзя автоматически считать ни корректной защитой, ни ошибкой самого плагина: исходные ответы до фильтрации не сохранены. List/dict exception — конкретный дефект proxy. Post-run модельных повторов для компенсации не выполнялось.

Ещё два `semantic_search` завершились upstream error, который proxy нормализовал; его исходная причина отсутствует в actor events. Всего A содержит семь failed MCP items и 16 ненулевых shell завершений; B — шесть ненулевых shell завершений. Ненулевой shell exit может означать, например, отсутствие совпадений, поэтому не равнозначен product failure. Turn-level error events отсутствуют.

Точное сопоставление вопросов, args, request ids, native items, durations и неизвестных причин находится в [transport-failure-evidence.json](transport-failure-evidence.json). В [A/proxy-audit.jsonl.gz](A/proxy-audit.jsonl.gz) сохранён неизменённый audit: 161 request, 156 response, 5 blocked response. Оригинальный использованный proxy сохранён в [repro/codex39_mcp_proxy.py](repro/codex39_mcp_proxy.py); его hash проверяется по frozen manifest. Никакой исправленный proxy не подменяет исторический артефакт.

## Ручная оценка ответов после завершения обоих акторов

| Диагностическая оценка | A | B |
|---|---:|---:|
| Pass | 29 | 25 |
| Partial | 10 | 13 |
| Fail | 0 | 1 |

Это субъективный, открытый по условиям post-run review, **не калиброванная accuracy** и не доказательство общего превосходства. Оценивался буквальный запрос с контекстом; исторические gold facts использовались как вспомогательный ориентир. Отсутствие нового tool call или отдельного исторического факта само по себе не означает fail.

Рецензии: [Q01–Q13](quality/quality-Q01-Q13.md), [Q14–Q26](quality/quality-Q14-Q26.md), [Q27–Q39](quality/quality-Q27-Q39.md), рядом сохранены исходные JSON. В актуальной Q36 учтены поздние миграции: итоговый unique `firm_id` верен, а `actor` был переименован в `creator`; прежняя критика по одной начальной миграции отменена. В Q39 отсутствие у B выделенного `zeitwerk.rb` — неполнота конкретного ответа, а не утверждение, что общие ActiveSupport inflections не действуют. Узкая формулировка Q24 оценивалась отдельно от явного autoload-вопроса Q39.

## Условия и отсутствие переноса старых ответов

- Один новый native Codex thread на A и один на B; внутри каждого Q01…Q39 последовательно, с естественным накоплением контекста.
- Явно заданные `gpt-6-luna`, `medium`; одинаковые исходный bare opening и тексты вопросов. Нет `context_added`, gold, сохранённого transcript/checkpoint или старых ответов в actor input. [questions-only.json](questions-only.json) — ровно исполненная проекция; opening hash записан в manifest.
- Source HEAD `afdbc18d53c3336d5d50c7bba2200863fbe34ca6`; shipped Codex plugin `0.53.5`, отдельная frozen копия свежего build и обязательных root assets. Исследуемый корпус `/Users/Shared/nav-ab/repo-master`, HEAD `f88b42f3c286815ea43b464960205d56445ee2e6`, существующий alias `taxdome-worktree-navmaster`. Reindex/изменения registry не выполнялись; корпус остался чистым.
- В A реально загружены только 18 навыков плагина, 14 native-trusted hooks и один MCP; actual SessionStart hook выдаёт core с filename-first правилом. В B — 0 включённых навыков, 0 hooks, 0 MCP. В обоих `instructionSources: []`, одинаковые общие features и managed profile.
- Native filesystem/profile ограничивает чтение корпусом и необходимыми runtime/plugin assets, запрещает private homes, auth, gold, прошлые ответы, соседние сессии, `.git` и repository docs/Markdown. Сеть model shell выключена. MCP proxy ограничивает alias/path и скрывает mutating tools. Реальные source и guide payload были сверены raw/proxy без изменений.
- Контроллер и backend запущены с явным whitelist окружения; вопросы передаются только через JSON-RPC stdin, auth — через отдельный FS-denied файл. Это ограниченная защита benchmark-данных: native macOS profile не обеспечивает универсальную изоляцию process metadata; этот предел не скрывается.

Подтверждения: [final-proof-summary.json](final-proof-summary.json), [independent-transport-proof.json](independent-transport-proof.json), [proofs](proofs/), [final-manifest.json](final-manifest.json). Filesystem enforcement проверено реальными чтениями, а не только инструкциями модели. Настройки native profiles соответствуют [официальной документации Codex permissions](https://learn.chatgpt.com/docs/permissions); фактические результаты проверок сохранены локально.

## Артефакты и проверка целостности

- [summary.json](summary.json): точные totals/ratios; [A/metrics.json](A/metrics.json), [B/metrics.json](B/metrics.json): audited per-question usage/tool counts и final-answer provenance.
- [A/answers](A/answers/), [B/answers](B/answers/): по 39 читаемых финальных ответов; `per-question.csv`, marks и status рядом.
- [A/events.jsonl.gz](A/events.jsonl.gz), [B/events.jsonl.gz](B/events.jsonl.gz): lossless global raw streams, без дублирующих per-question event dumps. [raw-manifest.json](raw-manifest.json) содержит исходные bytes/SHA256 и compressed bytes/SHA256. Декомпрессия обоих архивов сверена с исходным SHA256.
- [repro](repro/): исходный реально использованный runner/RPC/proxy/CLI shim/collector и настройки без credential values. Homes, auth-файлы/ссылки, runtime binaries и исходный gold-файл не архивируются.

Frozen manifest проверяет 9834 явно перечисленных файла. Дополнительный archive SHA256 inventory фиксирует доставленные артефакты; source actor working files остаются в `.tmp/codex39` и не подменяются исправлениями или последующими рецензиями.

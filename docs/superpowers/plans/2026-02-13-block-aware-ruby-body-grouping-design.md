# Block-Aware Ruby Body Grouping (D+)

d

## Проблема

### 1. Артефакты `end`

Одиночные `end` keywords от `do...end` блоков в scope/callback/DSL создают
дегенеративные чанки. RubyBodyGrouper классифицирует `end` как `"other"`
(STATEMENT_KEYWORDS) → отдельная группа → с prepend class header →
`"class Pipeline::StageClient < ApplicationRecord\nend"` → 55+ chars → проходит
фильтр.

**Результат:** 78% результатов поиска по Pipeline::StageClient — артефакты с
идентичным score 0.678.

### 2. Потерянные тела блоков

Многострочные `do...end` и `{ }` блоки в scopes/callbacks/DSL теряют тело. Body
lines внутри блока → continuation (undefined) → pendingBlanks → dropped при
смене типа группы.

Пример: `scope :affected_by_time_entry, ->(time_entry) do` — только декларация,
без body (joins, where, distinct).

### 3. Concern hooks

`included do...end` не распознаётся → содержимое разлетается по разным чанкам,
вложенные блоки (aasm do...end) полностью теряются.

## Решение

Модифицировать `RubyBodyGrouper.groupLines()` для отслеживания глубины
вложенности блоков.

### Изменения в `ruby-body-grouper.ts`

#### 1. STATEMENT_KEYWORDS: удалить `"end"`

#### 2. DECLARATION_KEYWORDS: добавить

```typescript
// state machine
aasm: "state_machine",

// class-level attributes
class_attribute: "attributes",
mattr_accessor: "attributes",
mattr_reader: "attributes",
mattr_writer: "attributes",
cattr_accessor: "attributes",
cattr_reader: "attributes",
cattr_writer: "attributes",
```

#### 3. Block-depth tracking в `groupLines()`

Два счётчика:

- `blockDepth` — для `do...end` (regex `/\bdo\s*(\|[^|]*\|)?\s*(#.*)?$/`)
- `braceDepth` — для `{ }` (count `{` и `}` на строке, кумулятивный баланс)

Exception list (их `do` НЕ инкрементирует depth):

```typescript
const BLOCK_DEPTH_EXCEPTIONS = new Set([
  "included", // included do...end  → flat body
  "extended", // extended do...end  → flat body
  "class_methods", // class_methods do...end → flat body
]);
```

Алгоритм в `groupLines()`:

```
Для каждой строки:
  1. Если blockDepth > 0 (уже внутри блока):
     - push в pendingBlanks
     - Проверить вложенный do → blockDepth++
     - Проверить end → blockDepth--
     - Если blockDepth вернулся к 0: ABSORB pendingBlanks в currentLines
     - continue

  2. Классифицировать строку нормально (classifyLine)
  3. Обработать классификацию (same type / different type / undefined)
  4. Проверить `do` на конце строки (НЕ в exception list) → blockDepth++
  5. Проверить `{`/`}` баланс → braceDepth += opens - closes
```

Аналогичная логика для `braceDepth` (многострочные `-> { }` lambda).

### Как concern чанкируется после фикса

До:

```
Chunk 1: module...\nextend...\nincluded do\ninclude AASM  (обрезано)
Chunk 2: module...\nenum :status, {...}                    (оторван от included)
Chunk 3: module...\nvalidates x4                           (оторван от included)
Chunk 4: module...\nend\nevent :succeed...                  (артефакт + AASM фрагмент)
ПОТЕРЯНО: aasm do, states, event :process
```

После:

```
Chunk 0 (function): def self.table_name_prefix...end
Chunk 1 (includes): extend ActiveSupport::Concern, include AASM
Chunk 2 (enums): enum :status, {...}
Chunk 3 (validations): validates x4
Chunk 4 (state_machine): aasm do...states...events...end  ← ЦЕЛИКОМ
```

`included do`/`end` прозрачны — не создают групп и артефактов.

### Тест-кейсы

1. `do...end` scope body захватывается в группу scopes
2. `-> { }` многострочная lambda захватывается
3. Вложенные `{ }` (hash внутри lambda) корректно трекаются
4. `end` не создаёт отдельную группу "other"
5. `do...end` scope → inline `{ }` scope (микс)
6. `aasm do...end` с вложенными `event do...end` → одна группа state_machine
7. `included do...end` прозрачен — содержимое группируется как flat body
8. `extended do...end` прозрачен — аналогично included
9. `class_attribute`, `mattr_accessor` → группа "attributes"
10. Неизвестные идентификаторы (`where`, `presence`) → continuation
11. Callback `after_commit do...end` → body захвачен
12. Рандомные DSL-методы не в keywords → continuation

### Ожидаемый результат после реиндексации

- Pipeline::StageClient: 7 артефактных чанков → 0
- Scope чанки содержат полное тело (joins, where, distinct)
- Concern hooks (included/extended) прозрачны
- AASM state machine — один семантический чанк
- Нет загрязнения результатов поиска

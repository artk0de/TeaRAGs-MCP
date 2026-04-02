# File-Level find_symbol Design

## Problem

При file-level группировке explore инструменты не отдают структуру содержимого:

- **`semantic_search`/`rank_chunks`/`find_similar` с `level: "file"`** — dedup
  (один лучший чанк на файл). Для markdown не собирается оглавление из
  `headingPath`. Для кода — нет outline по символам, просто один
  представительный чанк.
- **`find_symbol` по классу** — `outlineClass` отдаёт тело class chunk в content
  вместо структуры по символам. Enrichment merge берёт `git.file` от первого
  чанка без осознанной агрегации.
- **`find_symbol` по файлу** — отсутствует как точка входа. Нельзя запросить
  структуру файла через `find_symbol(relativePath: "src/app.ts")`.

Логика группировки размазана: `outlineClass`/`outlineDoc` в symbol-resolve,
enrichment merge adhoc там же, `groupByFile` в strategies/base — чистый dedup
без структуры. Нет единого компонента, который владеет рендером группы чанков,
агрегацией enrichments и сборкой stats.

## Solution

1. **`ChunkGrouper`** — новый компонент в `explore/chunk-grouping/`. Заменяет
   `outlineClass`, `outlineDoc` и разбросанную логику merge enrichments.
   Владеет: рендером content, агрегацией enrichments, сборкой stats.
   `CodeChunkGrouper` и `DocChunkGrouper` — конкретные реализации.
2. **`relativePath` параметр** — новый параметр `find_symbol`, взаимоисключающий
   с `symbol`. Scroll по `relativePath` для file-level lookup любого типа файла.
3. **`parentName` → `parentSymbolId`** — rename через миграцию v11 (in-place
   `set_payload`). Для doc чанков значение меняется на
   `doc:<sha256(relativePath)[0:12]>`.
4. **`#` vs `.` separator в symbolId** — универсальная конвенция:
   `Class#instance`, `Class.static` для всех языков с классами.
5. **search-cascade обновление** — через `/optimize-skill` с новыми паттернами
   навигации.

## find_symbol: два уровня

### Chunk-level — один символ, content = исходный код

| Input                                    | Результат                          |
| ---------------------------------------- | ---------------------------------- |
| `find_symbol(symbol: "Reranker#rerank")` | Код метода                         |
| `find_symbol(symbol: "processData")`     | Код функции (top-level, без детей) |
| `find_symbol(symbol: "doc:abc123")`      | Текст секции с breadcrumbs         |

### File-level — группа чанков, content = синтетический outline

| Input                                          | Результат        |
| ---------------------------------------------- | ---------------- |
| `find_symbol(symbol: "Reranker")`              | Структура класса |
| `find_symbol(relativePath: "src/reranker.ts")` | Структура файла  |
| `find_symbol(relativePath: "docs/api.md")`     | TOC документа    |
| `find_symbol(symbol: "doc:<parentHash>")`      | TOC документа    |

Определение уровня: есть чанки с `parentSymbolId == query` → file-level. Один
символ без детей → chunk-level.

## ChunkGrouper

```
explore/
  chunk-grouping/
    chunk-grouper.ts                 # ChunkGrouper interface + dispatch
    chunk-grouper/
      code.ts                        # CodeChunkGrouper
      doc.ts                         # DocChunkGrouper
```

**Ответственности:**

1. **Content rendering** — синтетический outline по типу чанков
2. **Enrichment merge** — `git.file` из любого чанка (одинаковый для чанков
   одного файла, мержить нечего)
3. **Stats aggregation** — contentSize (sum), chunkCount, сборка payload

**`CodeChunkGrouper`** рендерит:

Класс (TypeScript):

```
class Reranker
  Reranker#rerank
  Reranker#score
  Reranker.create
```

Rails model (Ruby):

```
class User
  User.associations
  User.validations
  User.scopes
  User.callbacks
  User#authenticate
  User#full_name
  User.find_by_email
```

File-level (несколько top-level символов):

```
src/reranker.ts
  Reranker
    Reranker#rerank
    Reranker#score
  createReranker
  DEFAULTS
```

**`DocChunkGrouper`** рендерит TOC:

```
# API Guide
  ## Installation              doc:abc123
  ## Authentication            doc:def456
    ### OAuth                  doc:def456
    ### API Keys               doc:ghi789
  ## Usage                     doc:jkl012
```

Для code symbolId самодостаточен — `Reranker#rerank` содержит класс + метод +
тип (instance). DSL body groups (associations, validations) используют `.` как
static-level символы. Для doc symbolId opaque hash — пишется рядом с заголовком.

**Payload сгруппированного результата:**

- `content` = синтетический outline
- `symbolId` — для doc: `doc:<parentHash>`, для code: имя класса
- `relativePath`, `language`, `fileExtension`
- `isDocumentation`
- `contentSize` — sum
- `chunkCount` — количество чанков
- `git.file`

## Instance vs static symbolId separator

Универсальная конвенция для всех языков: `Class#method` — instance,
`Class.method` — static/class method.

| Язык       | Instance            | Static               | Детекция                                  |
| ---------- | ------------------- | -------------------- | ----------------------------------------- |
| Ruby       | `User#authenticate` | `User.find_by_email` | Node type: `method` vs `singleton_method` |
| Java       | `User#authenticate` | `User.findByEmail`   | `static` modifier на `method_declaration` |
| TypeScript | `Reranker#rerank`   | `Reranker.create`    | `static` modifier через `hasModifier()`   |
| Python     | `User#authenticate` | `User.find_all`      | `@staticmethod`/`@classmethod` decorator  |
| C#         | `User#Authenticate` | `User.FindByEmail`   | `static` modifier                         |
| Go         | —                   | —                    | Нет классов                               |

**Backlog:** Rust (`&self` детекция) — `tea-rags-mcp-f9hc`.

**Default:** Языки без детекции оставляют `.` (текущее поведение, без breaking
change).

**Изменение:** `tree-sitter.ts` — `buildSymbolId(name, parentName)` получает
`isStatic: boolean`. Каждый язык детектит static через свой AST и передаёт флаг.

## parentSymbolId: формат и миграция

### Формат

| Тип чанка        | parentSymbolId                     | Пример             |
| ---------------- | ---------------------------------- | ------------------ |
| Code method      | Имя класса                         | `Reranker`         |
| Code block (DSL) | Имя класса                         | `User`             |
| Code top-level   | undefined                          | —                  |
| Doc chunk        | `doc:<sha256(relativePath)[0:12]>` | `doc:7f3a2b1c9e4d` |

### Миграция `schema-v11-rename-parentname.ts`

In-place `set_payload` на всех точках, reindex не нужен.

1. Для каждой точки: скопировать `parentName` → `parentSymbolId`, удалить
   `parentName`
2. Создать text index на `parentSymbolId` (заменить существующий `parentName`
   index)
3. Обновить все ссылки в коде

Затронутый код:

- `CodeChunk.metadata.parentName` → `parentSymbolId` (`types.ts`)
- `StaticPayloadBuilder` → write `parentSymbolId` (`provider.ts`)
- `file-processor.ts` → set `parentSymbolId` для doc чанков
- `tree-sitter.ts` → set `parentSymbolId` для method чанков
- `explore-facade.ts` → scroll filter key
- `symbol-resolve.ts` → чтение payload field
- `reranker.ts` / пресеты → `groupBy: "parentSymbolId"`
- `decomposition.ts`, `refactoring.ts` → groupBy update

## explore-facade.ts: параметр `relativePath`

Новый параметр `find_symbol`, взаимоисключающий с `symbol`.

Когда `relativePath` передан — один scroll по `relativePath`, все чанки файла →
`ChunkGrouper`.

Когда `symbol` передан — существующие два scroll (symbolId + parentSymbolId),
`resolveSymbols` с `ChunkGrouper` для file-level результатов.

## Doc TOC как общее поведение группировки

`DocChunkGrouper` не специфичен для `find_symbol`. Это общее поведение при
file-level группировке markdown чанков во всех explore инструментах:

- `find_symbol(relativePath: "docs/api.md")` → TOC
- `semantic_search(query, metaOnly: true, level: "file")` → doc результаты
  включают TOC (`tea-rags-mcp-zrma`)
- `rank_chunks(rerank, metaOnly: true, level: "file")` → аналогично

Алгоритм TOC:

1. Чанки сортируются по startLine
2. Из каждого чанка извлекаются headingPath entries
3. Последовательные дубликаты дедуплицируются (один заголовок в соседних чанках)
4. Рендер: indent по depth + `#` × depth + text + symbolId

Несколько заголовков на один symbolId — нормально, они в одном чанке.

## search-cascade обновление

Через `/optimize-skill` — добавить:

- File outline через `find_symbol(relativePath: "path")` и
  `find_symbol(symbol: "doc:<parentHash>")`
- Конвенция `#` vs `.` в symbolId
- `parentSymbolId` (переименован из `parentName`)
- Паттерн использования Doc TOC

## MCP Schema

**find_symbol** — новый параметр `relativePath` (взаимоисключающий с `symbol`),
обновлённый description:

```
Find symbol by name or file path — direct lookup, no embedding.
Returns source code for individual symbols (functions, methods).
Returns structural outline for classes and files.
For doc files: heading TOC with chunk symbolId references.
Use relativePath parameter for file-level lookup.
```

**registry.ts** — обновить описание полей:

```
parentSymbolId (class name for code methods, doc:<hash> for doc chunks)
```

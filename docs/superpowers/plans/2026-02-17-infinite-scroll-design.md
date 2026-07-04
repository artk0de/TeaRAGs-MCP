# Infinite Scroll for L3 Doc Categories

**Date:** 2026-02-17 **Status:** Approved

## Problem

After splitting large articles into L3 sub-pages (search-strategies/,
deep-codebase-analysis/, agentic-data-driven-engineering/), users must click
"Next" to navigate between related sub-pages. Modern documentation sites load
the next article automatically when the user scrolls to the bottom — continuous
reading within a coherent topic.

## Solution

Add infinite scroll scoped to L3 categories. When a user reads a sub-page inside
a category (e.g., `search-strategies/index.md`), scrolling to the bottom
automatically loads the next sibling page (`preset-mapping.md`) below the
current content. This continues until the last page in the category.

Pages outside L3 categories (standalone files like `mental-model.md`,
`common-mistakes.md`) are unaffected.

## Approach: Eject DocItem/Layout + Fetch SSG HTML

**Chosen over:**

- **Wrap DocItem/Layout** — rejected because we need to control the TOC column
  conditionally
- **Fetch + DOM injection without swizzle** — rejected because injected MDX
  components (MermaidTeaRAGs) lose React hydration, and no TOC control
- **Build-time concatenation plugin** — rejected because it re-creates giant
  pages (defeats the split), duplicates content, and heavy build-time logic

## Architecture

### Files

| File                                          | Action                               | Purpose                                                 |
| --------------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `src/theme/DocItem/Layout/index.tsx`          | Eject (copy 71-line source + modify) | Replace TOC column conditionally, add InfiniteDocScroll |
| `src/theme/DocItem/Layout/styles.module.css`  | Eject (copy as-is)                   | Required by ejected Layout                              |
| `src/components/InfiniteDocScroll.tsx`        | Create                               | Core: fetch, append, track visible article, manage TOC  |
| `src/components/InfiniteDocScroll.module.css` | Create                               | Article separator, loading indicator                    |
| `src/components/infiniteScrollUtils.ts`       | Create                               | Sidebar tree walker, HTML parser, L3 detection          |

### Data Flow

```
Page loads
  → useDoc().metadata.next.permalink → URL of next page
  → useDocsSidebar().items → sidebar tree
  → findParentCategory(tree, currentPermalink) → L3 category or null
  → if null → no infinite scroll, render standard layout
  → if category found → check if next page is in same category
    ↓ yes: activate
  User scrolls near bottom
  → IntersectionObserver on sentinel div fires
  → fetch(nextPermalink) → full SSG HTML page
  → DOMParser → extract <article .theme-doc-markdown> content
  → Extract headings (h2, h3) → build TOC items for loaded article
  → Extract next pagination link → chain to subsequent page
  → Append content below with visual separator
  → Repeat until last page in category
  Scroll tracking
  → IntersectionObserver on each article separator
  → Visible article changes → history.replaceState(newURL)
  → Sidebar: toggle .menu__link--active CSS class via DOM
  → TOC: swap displayed headings to current article's TOC
```

### L3 Detection

Walk sidebar tree recursively. A page qualifies for infinite scroll when:

1. It belongs to a category (has a parent `type: "category"` node)
2. Its `metadata.next` page belongs to the **same** category

```
sidebar tree:
  agent-integration/          ← L2 category
    mental-model.md           ← standalone → NO infinite scroll
    common-mistakes.md        ← standalone → NO infinite scroll
    search-strategies/        ← L3 category
      index.md                  ← YES (next = preset-mapping, same category)
      preset-mapping.md         ← YES (next = multi-tool-cascade, same category)
      multi-tool-cascade.md     ← YES
      custom-reranking.md       ← YES
      prompt-examples.md        ← last in category → NO more loading
```

Helper:
`findParentCategory(sidebarItems, permalink) → PropSidebarItemCategory | null`

### Fetching & Parsing

1. `fetch(nextPermalink)` → full SSG HTML
2. `new DOMParser().parseFromString(html, 'text/html')`
3. Content: `doc.querySelector('article .theme-doc-markdown')` — article body
   only (no breadcrumbs, footer, paginator)
4. TOC: `doc.querySelectorAll('article h2[id], article h3[id]')` →
   `{id, text, level}[]`
5. Next link:
   `doc.querySelector('.pagination-nav__link--next')?.getAttribute('href')` — to
   chain-load subsequent pages without React hooks
6. Title: `doc.querySelector('article h1')?.textContent` — for separator display

### Visual Separator

Between loaded articles:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Preset Mapping                    2 / 5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

- Article title from fetched `<h1>`
- Position counter (N / total) from category item count
- Gold accent styling (#c5a864) matching existing theme
- Acts as IntersectionObserver target for URL/TOC switching

### TOC Management

Ejected DocItem/Layout controls the TOC column:

```tsx
const [activeToc, setActiveToc] = useState<TocItem[]>(initialToc);

// In the layout:
<div className="col col--3">
  <CustomTOC items={activeToc} />
</div>;
```

- Initial page: TOC from `useDoc().toc` (native Docusaurus data)
- Loaded articles: TOC parsed from fetched HTML headings
- Switch: IntersectionObserver detects new article entering viewport center →
  `setActiveToc(loadedArticleToc)`
- Clicking TOC item scrolls to heading via `#id` anchor (works because heading
  IDs exist in DOM)

### Sidebar Active Link

After `history.replaceState()`:

```ts
document
  .querySelector(".menu__link--active")
  ?.classList.remove("menu__link--active");
document
  .querySelector(`a.menu__link[href="${newPermalink}"]`)
  ?.classList.add("menu__link--active");
```

DOM manipulation, no React Router hacking.

### Edge Cases

| Edge case                        | Handling                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Last page in L3 category         | No sentinel. Standard paginator shows "Next" to next category.                                                                             |
| User clicks sidebar link         | Normal Docusaurus navigation — full page load. Scroll state resets.                                                                        |
| User clicks TOC heading          | Smooth scroll to `#id` — works for initial and loaded content.                                                                             |
| Direct URL access to middle page | Only that page loads first. Subsequent pages load on scroll. No backward loading.                                                          |
| Network error on fetch           | Silent fail. Original paginator visible as fallback.                                                                                       |
| Mobile                           | No desktop TOC. Infinite scroll works in main content area. Mobile TOC stays for initial page only.                                        |
| Theme toggle (dark/light)        | Initial page's Mermaid diagrams update (React). Loaded articles' Mermaid SVGs stay in original theme (no hydration). Acceptable edge case. |
| Back button                      | Returns to page before the reading session (replaceState behavior).                                                                        |

## Decisions

- **Eject over wrap**: Need TOC column control. 71-line source, low maintenance.
- **Fetch SSG HTML over dynamic import**: Simpler, no dependency on Docusaurus
  internals (ComponentCreator, route registry hashes). All components render
  correctly as static HTML.
- **replaceState over pushState**: Continuous reading is one session, not a
  series of navigations. Back button goes to previous page, not previous scroll
  position.
- **DOM manipulation for sidebar**: Lightest touch. No React Router hacking, no
  additional swizzling.
- **No user toggle**: Always on for L3 categories. YAGNI.
- **No backward loading**: If user lands on page 3/5, only pages 4 and 5 load on
  scroll. Not loading 1 and 2 above — complex and unexpected UX.

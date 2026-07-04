# Infinite Scroll for L3 Doc Categories — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** When reading a doc page inside an L3 category, scrolling to the bottom
automatically loads the next sibling page inline — continuous reading within a
topic.

**Architecture:** Eject `DocItem/Layout` (71-line source) to control the TOC
column. Add `InfiniteDocScroll` component that uses IntersectionObserver to
detect scroll-to-bottom, fetches next page's SSG HTML via `fetch()`, extracts
article content with DOMParser, and appends it below with a visual separator.
URL updates via `history.replaceState()`, TOC switches per visible article,
sidebar active link toggled via DOM.

**Tech Stack:** React 19, TypeScript, Docusaurus 3.9.2, IntersectionObserver
API, DOMParser API, CSS Modules

---

## Reference: Key Docusaurus internals

- `useDoc()` from `@docusaurus/plugin-content-docs/client` →
  `{ metadata: { next?: { title, permalink }, previous?, sidebar? }, toc: TocItem[], frontMatter }`
- `useDocsSidebar()` from `@docusaurus/plugin-content-docs/client` →
  `{ name: string, items: PropSidebarItem[] }` (nested tree)
- `PropSidebarItemCategory` →
  `{ type: 'category', items: PropSidebarItem[], href?, label }`
- `PropSidebarItemLink` → `{ type: 'link', href: string, label, docId? }`
- `TOC` component from `@theme/TOC` → accepts `toc` prop (array of
  `{ id, value, level }`)
- DocItem/Layout source:
  `node_modules/@docusaurus/theme-classic/src/theme/DocItem/Layout/index.tsx`
  (71 lines)
- DocItem/Layout CSS:
  `node_modules/@docusaurus/theme-classic/src/theme/DocItem/Layout/styles.module.css`
  (17 lines)
- Existing swizzled theme files: `Root.tsx`, `Navbar/Logo/index.tsx`,
  `Logo/index.tsx`
- CSS vars: `--ifm-color-primary: #c5a864`, `--tea-border-subtle`,
  `--tea-transition`, `--tea-glow-gold`

---

## Task 1: Create infiniteScrollUtils.ts — sidebar walker & HTML parser

**Files:**

- Create: `website/src/components/infiniteScrollUtils.ts`

**Step 1: Create the utility module**

```typescript
// website/src/components/infiniteScrollUtils.ts

/**
 * Utilities for infinite scroll: L3 category detection and HTML content extraction.
 */

// Re-use Docusaurus sidebar types
interface SidebarLink {
  type: "link";
  href: string;
  label: string;
}

interface SidebarCategory {
  type: "category";
  label: string;
  items: SidebarItem[];
  href?: string;
}

interface SidebarHtml {
  type: "html";
}

type SidebarItem = SidebarLink | SidebarCategory | SidebarHtml;

export interface TocItem {
  id: string;
  value: string;
  level: number;
}

export interface LoadedArticle {
  permalink: string;
  title: string;
  htmlContent: string;
  toc: TocItem[];
  nextPermalink: string | null;
}

/**
 * Find the parent category that contains the given permalink.
 * Returns the category and the list of sibling link hrefs within it.
 * Returns null if the permalink is not inside any category (standalone page).
 */
export function findParentCategory(
  items: SidebarItem[],
  permalink: string,
): { category: SidebarCategory; siblingHrefs: string[] } | null {
  for (const item of items) {
    if (item.type !== "category") continue;

    const links = collectLinks(item.items);
    // Also check if category href itself matches (index.md)
    const allHrefs = item.href ? [item.href, ...links] : links;
    if (allHrefs.includes(permalink)) {
      return { category: item, siblingHrefs: allHrefs };
    }

    // Recurse into nested categories
    const nested = findParentCategory(item.items, permalink);
    if (nested) return nested;
  }
  return null;
}

/**
 * Collect all link hrefs from a flat list of sidebar items (non-recursive).
 */
function collectLinks(items: SidebarItem[]): string[] {
  return items
    .filter((item): item is SidebarLink => item.type === "link")
    .map((item) => item.href);
}

/**
 * Check if two permalinks belong to the same L3 category.
 */
export function areSiblings(
  sidebarItems: SidebarItem[],
  currentPermalink: string,
  nextPermalink: string,
): boolean {
  const parentInfo = findParentCategory(sidebarItems, currentPermalink);
  if (!parentInfo) return false;
  return parentInfo.siblingHrefs.includes(nextPermalink);
}

/**
 * Get total count of pages in the category and the position of a given permalink.
 */
export function getCategoryPosition(
  sidebarItems: SidebarItem[],
  permalink: string,
): { position: number; total: number } | null {
  const parentInfo = findParentCategory(sidebarItems, permalink);
  if (!parentInfo) return null;
  const idx = parentInfo.siblingHrefs.indexOf(permalink);
  if (idx === -1) return null;
  return { position: idx + 1, total: parentInfo.siblingHrefs.length };
}

/**
 * Fetch a doc page's SSG HTML, extract article content, TOC, and next link.
 */
export async function fetchArticle(
  permalink: string,
): Promise<LoadedArticle | null> {
  try {
    const response = await fetch(permalink);
    if (!response.ok) return null;

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Extract the markdown content area
    const contentEl = doc.querySelector(".theme-doc-markdown");
    if (!contentEl) return null;

    // Extract title from first h1
    const h1 = contentEl.querySelector("h1");
    const title = h1?.textContent ?? "";
    // Remove h1 from content to avoid duplication (separator shows the title)
    h1?.remove();

    // Extract TOC from headings
    const toc = extractToc(contentEl);

    // Extract next pagination link
    const nextLink = doc.querySelector(".pagination-nav__link--next");
    const nextPermalink = nextLink?.getAttribute("href") ?? null;

    return {
      permalink,
      title,
      htmlContent: contentEl.innerHTML,
      toc,
      nextPermalink,
    };
  } catch {
    return null;
  }
}

/**
 * Extract TOC items from h2 and h3 headings in a DOM element.
 */
function extractToc(container: Element): TocItem[] {
  const headings = container.querySelectorAll("h2[id], h3[id]");
  return Array.from(headings).map((el) => ({
    id: el.id,
    value: el.textContent ?? "",
    level: el.tagName === "H2" ? 2 : 3,
  }));
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd website && npx tsc --noEmit` Expected: No errors related to
infiniteScrollUtils.ts

**Step 3: Commit**

```bash
git add website/src/components/infiniteScrollUtils.ts
git commit -m "feat(website): add infiniteScrollUtils — sidebar walker and HTML parser"
```

---

## Task 2: Create InfiniteDocScroll component

**Files:**

- Create: `website/src/components/InfiniteDocScroll.tsx`
- Create: `website/src/components/InfiniteDocScroll.module.css`

**Step 1: Create the CSS module**

```css
/* website/src/components/InfiniteDocScroll.module.css */

.separator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin: 3rem 0 2rem;
  padding: 1.25rem 0;
  position: relative;
}

.separator::before,
.separator::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--ifm-color-primary-dark),
    transparent
  );
}

.separatorContent {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  white-space: nowrap;
}

.separatorTitle {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--ifm-color-primary);
  letter-spacing: -0.01em;
}

.separatorPosition {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ifm-color-primary-light);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.loadedArticle {
  scroll-margin-top: calc(var(--ifm-navbar-height) + 1rem);
}

.sentinel {
  height: 1px;
  width: 100%;
}

.loading {
  display: flex;
  justify-content: center;
  padding: 2rem 0;
}

.loadingDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ifm-color-primary);
  margin: 0 4px;
  animation: pulse 1.2s ease-in-out infinite;
}

.loadingDot:nth-child(2) {
  animation-delay: 0.2s;
}

.loadingDot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.2;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}
```

**Step 2: Create the React component**

```tsx
// website/src/components/InfiniteDocScroll.tsx

import React, { useCallback, useEffect, useRef, useState } from "react";

import styles from "./InfiniteDocScroll.module.css";
import {
  areSiblings,
  fetchArticle,
  getCategoryPosition,
  type LoadedArticle,
  type TocItem,
} from "./infiniteScrollUtils";

interface Props {
  /** Sidebar items tree from useDocsSidebar() */
  sidebarItems: unknown[];
  /** Current page permalink from useDoc().metadata.permalink */
  currentPermalink: string;
  /** Next page info from useDoc().metadata.next */
  nextPage: { title: string; permalink: string } | undefined;
  /** Current page's TOC from useDoc().toc */
  initialToc: TocItem[];
  /** Callback to update the active TOC in the parent Layout */
  onTocChange: (toc: TocItem[]) => void;
}

export default function InfiniteDocScroll({
  sidebarItems,
  currentPermalink,
  nextPage,
  initialToc,
  onTocChange,
}: Props): React.ReactNode {
  const [articles, setArticles] = useState<LoadedArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const articleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const activePermalinkRef = useRef(currentPermalink);

  // Determine the next permalink to load
  const nextToLoad =
    articles.length === 0
      ? nextPage?.permalink
      : articles[articles.length - 1].nextPermalink;

  // Check if infinite scroll should be active
  const isActive =
    nextPage &&
    areSiblings(
      sidebarItems as Parameters<typeof areSiblings>[0],
      currentPermalink,
      nextPage.permalink,
    );

  // Load the next article
  const loadNext = useCallback(async () => {
    if (loading || !hasMore || !nextToLoad) return;

    // Check if the next page is still a sibling
    const stillSibling = areSiblings(
      sidebarItems as Parameters<typeof areSiblings>[0],
      currentPermalink,
      nextToLoad,
    );
    if (!stillSibling) {
      setHasMore(false);
      return;
    }

    setLoading(true);
    const article = await fetchArticle(nextToLoad);
    setLoading(false);

    if (!article) {
      setHasMore(false);
      return;
    }

    setArticles((prev) => [...prev, article]);

    // Check if there's another sibling after this one
    if (
      !article.nextPermalink ||
      !areSiblings(
        sidebarItems as Parameters<typeof areSiblings>[0],
        currentPermalink,
        article.nextPermalink,
      )
    ) {
      setHasMore(false);
    }
  }, [loading, hasMore, nextToLoad, sidebarItems, currentPermalink]);

  // IntersectionObserver for sentinel (trigger loading)
  useEffect(() => {
    if (!isActive || !hasMore) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadNext();
        }
      },
      { rootMargin: "400px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isActive, hasMore, loadNext]);

  // IntersectionObserver for tracking visible article (URL + TOC + sidebar)
  useEffect(() => {
    if (articles.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const permalink = entry.target.getAttribute("data-permalink");
            if (permalink && permalink !== activePermalinkRef.current) {
              activePermalinkRef.current = permalink;

              // Update URL
              window.history.replaceState(null, "", permalink);

              // Update sidebar active link
              updateSidebarActiveLink(permalink);

              // Update TOC
              const article = articles.find((a) => a.permalink === permalink);
              if (article) {
                onTocChange(article.toc);
              }
            }
          }
        }
      },
      {
        rootMargin: "-30% 0px -65% 0px", // Trigger when article enters upper third
      },
    );

    // Observe all loaded article separators
    for (const [, el] of articleRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [articles, onTocChange]);

  // Restore original page state when scrolling back to top
  useEffect(() => {
    if (articles.length === 0) return;

    const handleScroll = () => {
      // If scrolled near the top, restore original page
      if (
        window.scrollY < 300 &&
        activePermalinkRef.current !== currentPermalink
      ) {
        activePermalinkRef.current = currentPermalink;
        window.history.replaceState(null, "", currentPermalink);
        updateSidebarActiveLink(currentPermalink);
        onTocChange(initialToc);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [articles, currentPermalink, initialToc, onTocChange]);

  if (!isActive) return null;

  return (
    <>
      {articles.map((article) => {
        const pos = getCategoryPosition(
          sidebarItems as Parameters<typeof getCategoryPosition>[0],
          article.permalink,
        );

        return (
          <div
            key={article.permalink}
            className={styles.loadedArticle}
            data-permalink={article.permalink}
            ref={(el) => {
              if (el) articleRefs.current.set(article.permalink, el);
            }}
          >
            {/* Separator */}
            <div className={styles.separator}>
              <div className={styles.separatorContent}>
                <span className={styles.separatorTitle}>{article.title}</span>
                {pos && (
                  <span className={styles.separatorPosition}>
                    {pos.position} / {pos.total}
                  </span>
                )}
              </div>
            </div>

            {/* Article content */}
            <div
              className="theme-doc-markdown markdown"
              dangerouslySetInnerHTML={{ __html: article.htmlContent }}
            />
          </div>
        );
      })}

      {/* Loading indicator */}
      {loading && (
        <div className={styles.loading}>
          <div className={styles.loadingDot} />
          <div className={styles.loadingDot} />
          <div className={styles.loadingDot} />
        </div>
      )}

      {/* Sentinel for triggering next load */}
      {hasMore && <div ref={sentinelRef} className={styles.sentinel} />}
    </>
  );
}

/**
 * Update sidebar active link via DOM class toggling.
 */
function updateSidebarActiveLink(permalink: string): void {
  // Remove active from current
  const current = document.querySelector(
    ".menu__link--active:not(.menu__link--sublist)",
  );
  if (current) {
    current.classList.remove("menu__link--active");
  }

  // Add active to new link
  const next = document.querySelector(`a.menu__link[href="${permalink}"]`);
  if (next) {
    next.classList.add("menu__link--active");
  }
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd website && npx tsc --noEmit` Expected: No errors related to
InfiniteDocScroll

**Step 4: Commit**

```bash
git add website/src/components/InfiniteDocScroll.tsx website/src/components/InfiniteDocScroll.module.css
git commit -m "feat(website): add InfiniteDocScroll component with fetch, TOC, and URL tracking"
```

---

## Task 3: Eject and modify DocItem/Layout

**Files:**

- Create: `website/src/theme/DocItem/Layout/index.tsx` (ejected + modified)
- Create: `website/src/theme/DocItem/Layout/styles.module.css` (copy from
  node_modules)

**Step 1: Copy the CSS module as-is**

Copy from
`node_modules/@docusaurus/theme-classic/src/theme/DocItem/Layout/styles.module.css`:

```css
/* website/src/theme/DocItem/Layout/styles.module.css */

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

.docItemContainer header + *,
.docItemContainer article > *:first-child {
  margin-top: 0;
}

@media (min-width: 997px) {
  .docItemCol {
    max-width: 75% !important;
  }
}
```

**Step 2: Create the ejected Layout with infinite scroll integration**

The modifications vs original (diff summary):

- Add `useState` for `activeToc`
- Import `InfiniteDocScroll` and `useDocsSidebar`
- Add `BrowserOnly` wrapper for client-side-only InfiniteDocScroll
- Replace `DocItemTOCDesktop` with conditional `TOC` using `activeToc`
- Place `InfiniteDocScroll` after `DocItemPaginator`

```tsx
// website/src/theme/DocItem/Layout/index.tsx

/**
 * Ejected from @docusaurus/theme-classic DocItem/Layout.
 * Modified to support infinite scroll within L3 doc categories.
 */

import BrowserOnly from "@docusaurus/BrowserOnly";
import { useDoc, useDocsSidebar } from "@docusaurus/plugin-content-docs/client";
import { ThemeClassNames, useWindowSize } from "@docusaurus/theme-common";
import type { TocItem } from "@site/src/components/infiniteScrollUtils";
import ContentVisibility from "@theme/ContentVisibility";
import DocBreadcrumbs from "@theme/DocBreadcrumbs";
import DocItemContent from "@theme/DocItem/Content";
import DocItemFooter from "@theme/DocItem/Footer";
import type { Props } from "@theme/DocItem/Layout";
import DocItemPaginator from "@theme/DocItem/Paginator";
import DocItemTOCMobile from "@theme/DocItem/TOC/Mobile";
import DocVersionBadge from "@theme/DocVersionBadge";
import DocVersionBanner from "@theme/DocVersionBanner";
import TOC from "@theme/TOC";
import clsx from "clsx";
import React, { useCallback, useState, type ReactNode } from "react";

import styles from "./styles.module.css";

function useDocTOC() {
  const { frontMatter, toc } = useDoc();
  const windowSize = useWindowSize();

  const hidden = frontMatter.hide_table_of_contents;
  const canRender = !hidden && toc.length > 0;

  const mobile = canRender ? <DocItemTOCMobile /> : undefined;

  const desktop =
    canRender && (windowSize === "desktop" || windowSize === "ssr");

  return {
    hidden,
    mobile,
    canRenderDesktop: desktop,
    toc,
    frontMatter,
  };
}

export default function DocItemLayout({ children }: Props): ReactNode {
  const docTOC = useDocTOC();
  const { metadata } = useDoc();
  const sidebar = useDocsSidebar();

  // Active TOC state — switches when infinite scroll changes visible article
  const [activeToc, setActiveToc] = useState<TocItem[]>(docTOC.toc);

  const handleTocChange = useCallback((toc: TocItem[]) => {
    setActiveToc(toc);
  }, []);

  return (
    <div className="row">
      <div className={clsx("col", !docTOC.hidden && styles.docItemCol)}>
        <ContentVisibility metadata={metadata} />
        <DocVersionBanner />
        <div className={styles.docItemContainer}>
          <article>
            <DocBreadcrumbs />
            <DocVersionBadge />
            {docTOC.mobile}
            <DocItemContent>{children}</DocItemContent>
            <DocItemFooter />
          </article>
          <DocItemPaginator />
          {/* Infinite scroll: loads next sibling articles below */}
          <BrowserOnly>
            {() => {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const InfiniteDocScroll =
                require("@site/src/components/InfiniteDocScroll").default;
              return (
                <InfiniteDocScroll
                  sidebarItems={sidebar?.items ?? []}
                  currentPermalink={metadata.permalink}
                  nextPage={metadata.next}
                  initialToc={docTOC.toc}
                  onTocChange={handleTocChange}
                />
              );
            }}
          </BrowserOnly>
        </div>
      </div>
      {/* TOC desktop — uses activeToc which switches per visible article */}
      {docTOC.canRenderDesktop && (
        <div className="col col--3">
          <TOC
            toc={activeToc}
            minHeadingLevel={docTOC.frontMatter.toc_min_heading_level}
            maxHeadingLevel={docTOC.frontMatter.toc_max_heading_level}
            className={ThemeClassNames.docs.docTocDesktop}
          />
        </div>
      )}
    </div>
  );
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd website && npx tsc --noEmit` Expected: No errors

**Step 4: Commit**

```bash
git add website/src/theme/DocItem/Layout/index.tsx website/src/theme/DocItem/Layout/styles.module.css
git commit -m "feat(website): eject DocItem/Layout with infinite scroll and dynamic TOC"
```

---

## Task 4: Build verification & manual testing

**Step 1: Clear Docusaurus cache**

Run: `cd website && npm run clear` Expected: Cache cleared successfully

**Step 2: Run production build**

Run: `cd website && npm run build` Expected: Build succeeds with no errors.
Warnings about swizzled unsafe components are OK.

**Step 3: Start the prod server for manual testing**

Run: `cd website && npm run serve` Expected: Server starts on
http://localhost:3100

**Step 4: Manual test checklist**

Test on http://localhost:3100/tea-rags/agent-integration/search-strategies/

1. **Scroll to bottom** → preset-mapping article should load automatically
2. **Keep scrolling** → multi-tool-cascade, custom-reranking, prompt-examples
   load in sequence
3. **Check URL** → changes as you scroll between articles
4. **Check TOC** (right sidebar) → switches to show current article's headings
5. **Check sidebar** (left) → active link follows the current article
6. **Check separator** → shows article title + position (e.g. "Preset Mapping 2
   / 5")
7. **Check loaded content** → tables, code blocks, details/summary, AiQuery
   blockquotes, Mermaid diagrams render correctly
8. **Click TOC heading** → scrolls to correct position
9. **Scroll back to top** → URL and TOC revert to original page
10. **Navigate to standalone page** (e.g. mental-model.md) → no infinite scroll
11. **Navigate to last page** (prompt-examples.md) → no sentinel, no loading
12. **Test on different L3 category** (deep-codebase-analysis/) → same behavior

**Step 5: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(website): address infinite scroll issues found during testing"
```

---

## Task 5: Edge case hardening

**Files:**

- Modify: `website/src/components/InfiniteDocScroll.tsx`
- Modify: `website/src/components/infiniteScrollUtils.ts`

**Step 1: Handle dev server vs production**

The dev server (`npm run start`) uses hot-reloading and may not serve SSG HTML
the same way as production. Add a check:

In `infiniteScrollUtils.ts`, in `fetchArticle()`, add resilience for when
`.theme-doc-markdown` is not found (dev mode may use different class names):

```typescript
// Fallback selectors for content extraction
const contentEl =
  doc.querySelector(".theme-doc-markdown") ??
  doc.querySelector("article .markdown") ??
  doc.querySelector("article");
```

**Step 2: Prevent duplicate loads**

In `InfiniteDocScroll.tsx`, add a Set to track already-loaded permalinks:

```typescript
const loadedPermalinks = useRef(new Set<string>());

// In loadNext(), before fetching:
if (loadedPermalinks.current.has(nextToLoad)) {
  setHasMore(false);
  return;
}
// After successful fetch:
loadedPermalinks.current.add(article.permalink);
```

**Step 3: Handle SPA navigation cleanup**

When the user navigates away via sidebar click, the component unmounts naturally
— React handles cleanup. But `history.replaceState` may leave the URL on a
loaded article. Add cleanup in useEffect:

```typescript
// In InfiniteDocScroll, add cleanup effect
useEffect(() => {
  return () => {
    // Restore original URL when component unmounts (SPA navigation away)
    if (activePermalinkRef.current !== currentPermalink) {
      window.history.replaceState(null, "", currentPermalink);
    }
  };
}, [currentPermalink]);
```

**Step 4: Rebuild and verify**

Run: `cd website && npm run build && npm run serve` Expected: Build succeeds,
all tests from Task 4 still pass

**Step 5: Commit**

```bash
git add website/src/components/InfiniteDocScroll.tsx website/src/components/infiniteScrollUtils.ts
git commit -m "fix(website): harden infinite scroll — dedup, fallback selectors, cleanup"
```

---

## Task 6: Final build + commit

**Step 1: Run full production build**

Run: `cd website && npm run build` Expected: Build succeeds with zero errors

**Step 2: Type check**

Run: `cd website && npx tsc --noEmit` Expected: No type errors

**Step 3: Final commit (if changes)**

```bash
git add -A
git commit -m "feat(website): infinite scroll for L3 doc categories"
```

---

## Summary of all created/modified files

| File                                                  | Action           |
| ----------------------------------------------------- | ---------------- |
| `website/src/components/infiniteScrollUtils.ts`       | Create           |
| `website/src/components/InfiniteDocScroll.tsx`        | Create           |
| `website/src/components/InfiniteDocScroll.module.css` | Create           |
| `website/src/theme/DocItem/Layout/index.tsx`          | Create (ejected) |
| `website/src/theme/DocItem/Layout/styles.module.css`  | Create (copied)  |

/**
 * Utilities for infinite scroll: L3 category detection and HTML content extraction.
 */

// Re-use Docusaurus sidebar types
interface SidebarLink {
  type: 'link';
  href: string;
  label: string;
}

interface SidebarCategory {
  type: 'category';
  label: string;
  items: SidebarItem[];
  href?: string;
}

interface SidebarHtml {
  type: 'html';
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
    if (item.type !== 'category') continue;

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
    .filter((item): item is SidebarLink => item.type === 'link')
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
  console.log('[InfScroll] areSiblings', {
    currentPermalink,
    nextPermalink,
    found: !!parentInfo,
    siblingHrefs: parentInfo?.siblingHrefs,
    categoryLabel: parentInfo?.category.label,
  });
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
export async function fetchArticle(permalink: string): Promise<LoadedArticle | null> {
  try {
    const response = await fetch(permalink);
    if (!response.ok) return null;

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Extract the markdown content area (with fallback selectors)
    const contentEl =
      doc.querySelector('.theme-doc-markdown') ??
      doc.querySelector('article .markdown') ??
      doc.querySelector('article');
    if (!contentEl) return null;

    // Extract title from first h1
    const h1 = contentEl.querySelector('h1');
    const title = h1?.textContent ?? '';
    // Remove h1 from content to avoid duplication (separator shows the title)
    h1?.remove();

    // Extract TOC from headings
    const toc = extractToc(contentEl);

    // Extract next pagination link
    const nextLink = doc.querySelector('.pagination-nav__link--next');
    const nextPermalink = nextLink?.getAttribute('href') ?? null;

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
  const headings = container.querySelectorAll('h2[id], h3[id]');
  return Array.from(headings).map((el) => ({
    id: el.id,
    value: el.textContent ?? '',
    level: el.tagName === 'H2' ? 2 : 3,
  }));
}

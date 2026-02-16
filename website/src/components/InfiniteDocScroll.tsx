import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { TocItem, LoadedArticle } from './infiniteScrollUtils';
import {
  areSiblings,
  getCategoryPosition,
  fetchArticle,
} from './infiniteScrollUtils';
import styles from './InfiniteDocScroll.module.css';

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
  const loadedPermalinks = useRef(new Set<string>());

  // Determine the next permalink to load
  const nextToLoad = articles.length === 0
    ? nextPage?.permalink
    : articles[articles.length - 1].nextPermalink;

  // Check if infinite scroll should be active
  const isActive = nextPage && areSiblings(
    sidebarItems as Parameters<typeof areSiblings>[0],
    currentPermalink,
    nextPage.permalink,
  );

  // --- DEBUG ---
  console.log('[InfScroll] mount', {
    currentPermalink,
    nextPage,
    isActive,
    sidebarItemsLength: sidebarItems.length,
    nextToLoad,
    hasMore,
  });

  // Load the next article
  const loadNext = useCallback(async () => {
    console.log('[InfScroll] loadNext called', { loading, hasMore, nextToLoad });
    if (loading || !hasMore || !nextToLoad) return;

    // Prevent duplicate loads
    if (loadedPermalinks.current.has(nextToLoad)) {
      console.log('[InfScroll] duplicate, skipping', nextToLoad);
      setHasMore(false);
      return;
    }

    // Check if the next page is still a sibling
    const stillSibling = areSiblings(
      sidebarItems as Parameters<typeof areSiblings>[0],
      currentPermalink,
      nextToLoad,
    );
    console.log('[InfScroll] stillSibling?', stillSibling, nextToLoad);
    if (!stillSibling) {
      setHasMore(false);
      return;
    }

    setLoading(true);
    console.log('[InfScroll] fetching', nextToLoad);
    const article = await fetchArticle(nextToLoad);
    console.log('[InfScroll] fetched', article ? 'OK' : 'FAILED', article?.title);
    setLoading(false);

    if (!article) {
      setHasMore(false);
      return;
    }

    loadedPermalinks.current.add(article.permalink);
    setArticles((prev) => [...prev, article]);

    // Check if there's another sibling after this one
    if (!article.nextPermalink || !areSiblings(
      sidebarItems as Parameters<typeof areSiblings>[0],
      currentPermalink,
      article.nextPermalink,
    )) {
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
        console.log('[InfScroll] sentinel observed', entries[0]?.isIntersecting);
        if (entries[0]?.isIntersecting) {
          loadNext();
        }
      },
      { rootMargin: '400px' },
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
            const permalink = entry.target.getAttribute('data-permalink');
            if (permalink && permalink !== activePermalinkRef.current) {
              activePermalinkRef.current = permalink;

              // Update URL
              window.history.replaceState(null, '', permalink);

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
        rootMargin: '-30% 0px -65% 0px', // Trigger when article enters upper third
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
      if (window.scrollY < 300 && activePermalinkRef.current !== currentPermalink) {
        activePermalinkRef.current = currentPermalink;
        window.history.replaceState(null, '', currentPermalink);
        updateSidebarActiveLink(currentPermalink);
        onTocChange(initialToc);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [articles, currentPermalink, initialToc, onTocChange]);

  // Restore original URL when component unmounts (SPA navigation away)
  useEffect(() => {
    return () => {
      if (activePermalinkRef.current !== currentPermalink) {
        window.history.replaceState(null, '', currentPermalink);
      }
    };
  }, [currentPermalink]);

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
  const current = document.querySelector('.menu__link--active:not(.menu__link--sublist)');
  if (current) {
    current.classList.remove('menu__link--active');
  }

  // Add active to new link
  const next = document.querySelector(`a.menu__link[href="${permalink}"]`);
  if (next) {
    next.classList.add('menu__link--active');
  }
}

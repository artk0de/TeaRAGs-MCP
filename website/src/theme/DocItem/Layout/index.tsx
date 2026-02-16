/**
 * Ejected from @docusaurus/theme-classic DocItem/Layout.
 * Modified to support infinite scroll within L3 doc categories.
 */

import React, { useState, useCallback, type ReactNode } from 'react';
import clsx from 'clsx';
import { useWindowSize } from '@docusaurus/theme-common';
import { ThemeClassNames } from '@docusaurus/theme-common';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import { useDocsSidebar } from '@docusaurus/plugin-content-docs/client';
import BrowserOnly from '@docusaurus/BrowserOnly';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocVersionBanner from '@theme/DocVersionBanner';
import DocVersionBadge from '@theme/DocVersionBadge';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocItemContent from '@theme/DocItem/Content';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import ContentVisibility from '@theme/ContentVisibility';
import TOC from '@theme/TOC';
import type { Props } from '@theme/DocItem/Layout';
import type { TocItem } from '@site/src/components/infiniteScrollUtils';

import styles from './styles.module.css';

function useDocTOC() {
  const { frontMatter, toc } = useDoc();
  const windowSize = useWindowSize();

  const hidden = frontMatter.hide_table_of_contents;
  const canRender = !hidden && toc.length > 0;

  const mobile = canRender ? <DocItemTOCMobile /> : undefined;

  const desktop = canRender && (windowSize === 'desktop' || windowSize === 'ssr');

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
  const [activeToc, setActiveToc] = useState<TocItem[]>([...docTOC.toc]);

  const handleTocChange = useCallback((toc: TocItem[]) => {
    setActiveToc(toc);
  }, []);

  return (
    <div className="row">
      <div className={clsx('col', !docTOC.hidden && styles.docItemCol)}>
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
                require('@site/src/components/InfiniteDocScroll').default;
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

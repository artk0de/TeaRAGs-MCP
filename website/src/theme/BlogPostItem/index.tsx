import { useBlogPost } from "@docusaurus/plugin-content-blog/client";
import type { WrapperProps } from "@docusaurus/types";
import GiscusComments from "@site/src/components/GiscusComments";
import BlogPostItem from "@theme-original/BlogPostItem";
import type BlogPostItemType from "@theme/BlogPostItem";
import React, { type ReactNode } from "react";

type Props = WrapperProps<typeof BlogPostItemType>;

/**
 * Wraps the theme's BlogPostItem to append giscus comments.
 *
 * `isBlogPostPage` comes from the blog post context the theme already provides.
 * It is true only when the item renders as a standalone post page, and false in
 * the list / archive / tag / author views, which mount this very same component
 * once per excerpt. Docs pages never mount it at all.
 */
export default function BlogPostItemWrapper(props: Props): ReactNode {
  const { isBlogPostPage } = useBlogPost();

  return (
    <>
      <BlogPostItem {...props} />
      {isBlogPostPage && <GiscusComments />}
    </>
  );
}

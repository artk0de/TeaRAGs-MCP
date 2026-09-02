import { useColorMode } from "@docusaurus/theme-common";
import Giscus from "@giscus/react";
import React, { type ReactNode } from "react";

/**
 * giscus configuration for this site.
 *
 * `repoId` and `categoryId` are GitHub GraphQL node IDs read from the live
 * repository through the GitHub API (`repository { id, discussionCategories }`).
 * They are public identifiers, not secrets — giscus needs them client-side.
 *
 * The category is "Announcements" on purpose: only maintainers can open threads
 * there, so every post's discussion is created by the giscus GitHub App acting
 * for the repo owner, never by a visitor opening a stray thread.
 */
const GISCUS = {
  repo: "artk0de/TeaRAGs-MCP",
  repoId: "R_kgDOREOvjQ",
  category: "Announcements",
  categoryId: "DIC_kwDOREOvjc4C2lak",
} as const;

/**
 * Reactions and comments for one blog post, backed by GitHub Discussions.
 *
 * SSR-safe: `@giscus/react` returns `null` until an effect has loaded the
 * underlying custom element, so the prerendered HTML carries the wrapper
 * element and nothing else. `theme` is an attribute on the live widget — the
 * element posts a `setConfig` message to its iframe whenever the attribute
 * changes, so switching the site's colour mode re-themes it without a reload.
 */
export default function GiscusComments(): ReactNode {
  const { colorMode } = useColorMode();

  return (
    <section className="giscus-comments margin-top--xl">
      <Giscus
        repo={GISCUS.repo}
        repoId={GISCUS.repoId}
        category={GISCUS.category}
        categoryId={GISCUS.categoryId}
        mapping="pathname"
        reactionsEnabled="1"
        emitMetadata="0"
        inputPosition="bottom"
        theme={colorMode === "dark" ? "dark" : "light"}
        lang="en"
        loading="lazy"
      />
    </section>
  );
}

import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

import prismDark from "./src/theme/prism-tearags-dark";
import prismLight from "./src/theme/prism-tearags-light";

const config: Config = {
  title: "TeaRAGs",
  tagline: "Semantic code search via MCP",
  favicon: "img/favicon.ico",

  future: {
    v4: true,
  },

  url: "https://artk0de.github.io",
  baseUrl: "/TeaRAGs-MCP/",

  organizationName: "artk0de",
  projectName: "TeaRAGs-MCP",

  onBrokenLinks: "throw",

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
    mermaid: true,
  },

  themes: [
    "@docusaurus/theme-mermaid",
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        // Docs own the site root, so both base paths must be explicit — the
        // plugin cannot tell a /blog route from a doc when docs sit at "/".
        docsRouteBasePath: "/",
        indexBlog: true,
        blogRouteBasePath: "/blog",
      },
    ],
  ],

  stylesheets: [
    {
      href: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
      type: "text/css",
    },
  ],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl: "https://github.com/artk0de/TeaRAGs-MCP/tree/main/website/",
          remarkPlugins: [remarkMath],
          rehypePlugins: [rehypeKatex],
        },
        blog: {
          path: "./blog",
          routeBasePath: "blog",
          blogTitle: "TeaRAGs Blog",
          blogDescription: "Engineering notes on trajectory-enriched code retrieval",
          blogSidebarTitle: "Recent posts",
          blogSidebarCount: 10,
          postsPerPage: 10,
          showReadingTime: true,
          editUrl: "https://github.com/artk0de/TeaRAGs-MCP/tree/main/website/",
          remarkPlugins: [remarkMath],
          rehypePlugins: [rehypeKatex],
          onInlineAuthors: "throw",
          onInlineTags: "throw",
          onUntruncatedBlogPosts: "throw",
          feedOptions: {
            type: "all",
            title: "TeaRAGs Blog",
            description: "Engineering notes on trajectory-enriched code retrieval",
            copyright: `Copyright © ${new Date().getFullYear()} TeaRAGs contributors.`,
            xslt: true,
          },
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "TeaRAGs",
      logo: {
        alt: "TeaRAGs Logo",
        src: "img/logo.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        {
          to: "/api/tools",
          position: "left",
          label: "Tools Schema",
        },
        {
          to: "/changelog",
          position: "left",
          label: "Changelog",
        },
        {
          to: "/blog",
          position: "left",
          label: "Blog",
        },
        {
          href: "https://github.com/artk0de/TeaRAGs-MCP",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Introduction",
              to: "/introduction/what-is-tearags",
            },
            {
              label: "Quickstart",
              to: "/quickstart/installation",
            },
          ],
        },
        {
          title: "More",
          items: [
            {
              label: "Blog",
              to: "/blog",
            },
            {
              // Absolute: the feed is a generated file, not a route, so a
              // site-relative href trips onBrokenLinks on every page.
              label: "RSS",
              href: "https://artk0de.github.io/TeaRAGs-MCP/blog/rss.xml",
            },
            {
              label: "GitHub",
              href: "https://github.com/artk0de/TeaRAGs-MCP",
            },
            {
              label: "npm",
              href: "https://www.npmjs.com/package/tea-rags",
            },
          ],
        },
      ],
      copyright: `Copyright \u00a9 ${new Date().getFullYear()} TeaRAGs contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismLight,
      darkTheme: prismDark,
      additionalLanguages: ["bash", "json", "yaml", "toml"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

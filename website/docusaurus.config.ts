import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
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
        docsRouteBasePath: "/",
        indexBlog: false,
      },
    ],
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
          editUrl:
            "https://github.com/artk0de/tea-rags/tree/main/website/",
        },
        blog: false,
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
          href: "https://github.com/artk0de/tea-rags",
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
              label: "GitHub",
              href: "https://github.com/artk0de/tea-rags",
            },
            {
              label: "npm",
              href: "https://www.npmjs.com/package/@artk0de/tea-rags-mcp",
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

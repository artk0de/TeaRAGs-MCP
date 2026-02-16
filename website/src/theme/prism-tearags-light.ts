import type { PrismTheme } from "prism-react-renderer";

/**
 * TeaRAGs Light — warm gold-accented syntax theme
 *
 * Palette derived from brand vars:
 *   bg:        #faf9f5  (warm parchment)
 *   dark-gold: #917838  (--ifm-color-primary-darkest)
 */
const theme: PrismTheme = {
  plain: {
    color: "#2d2d2d",
    backgroundColor: "#faf9f5",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#8b8b8b", fontStyle: "italic" as const },
    },
    {
      types: ["punctuation"],
      style: { color: "#6b6b6b" },
    },
    {
      types: ["namespace"],
      style: { opacity: 0.8 },
    },
    {
      types: ["keyword", "builtin", "important", "atrule"],
      style: { color: "#917838" },
    },
    {
      types: ["string", "char", "attr-value", "template-string"],
      style: { color: "#5a7a38" },
    },
    {
      types: ["regex"],
      style: { color: "#9e6b30" },
    },
    {
      types: ["number", "boolean"],
      style: { color: "#b08245" },
    },
    {
      types: ["function", "method"],
      style: { color: "#6d5c2a" },
    },
    {
      types: ["class-name", "maybe-class-name", "type"],
      style: { color: "#7a6520" },
    },
    {
      types: ["variable", "parameter"],
      style: { color: "#2d2d2d" },
    },
    {
      types: ["property", "tag"],
      style: { color: "#8a7235" },
    },
    {
      types: ["attr-name"],
      style: { color: "#917838" },
    },
    {
      types: ["operator", "arrow"],
      style: { color: "#7a6520" },
    },
    {
      types: ["selector", "pseudo-class", "pseudo-element"],
      style: { color: "#5a7a38" },
    },
    {
      types: ["constant", "symbol"],
      style: { color: "#b08245" },
    },
    {
      types: ["deleted"],
      style: { color: "#c44040" },
    },
    {
      types: ["inserted"],
      style: { color: "#5a7a38" },
    },
    {
      types: ["changed"],
      style: { color: "#917838" },
    },
  ],
};

export default theme;

import type { PrismTheme } from "prism-react-renderer";

/**
 * TeaRAGs Dark — gold-accented syntax theme
 *
 * Palette derived from brand vars:
 *   bg:       #1b1b1d  (--tea-bg-depth-1)
 *   gold:     #c5a864  (--ifm-color-primary)
 *   light-gold: #deca9e
 */
const theme: PrismTheme = {
  plain: {
    color: "#d4d4d8",
    backgroundColor: "#1b1b1d",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#9b9ba6", fontStyle: "italic" as const },
    },
    {
      types: ["punctuation"],
      style: { color: "#8b8b96" },
    },
    {
      types: ["namespace"],
      style: { opacity: 0.8 },
    },
    {
      types: ["keyword", "builtin", "important", "atrule"],
      style: { color: "#c5a864" },
    },
    {
      types: ["string", "char", "attr-value", "template-string"],
      style: { color: "#a8c97f" },
    },
    {
      types: ["regex"],
      style: { color: "#d4a76a" },
    },
    {
      types: ["number", "boolean"],
      style: { color: "#e0a76a" },
    },
    {
      types: ["function", "method"],
      style: { color: "#deca9e" },
    },
    {
      types: ["class-name", "maybe-class-name", "type"],
      style: { color: "#d4af37" },
    },
    {
      types: ["variable", "parameter"],
      style: { color: "#d4d4d8" },
    },
    {
      types: ["property", "tag"],
      style: { color: "#cdb478" },
    },
    {
      types: ["attr-name"],
      style: { color: "#bb9b4e" },
    },
    {
      types: ["operator", "arrow"],
      style: { color: "#c5a864" },
    },
    {
      types: ["selector", "pseudo-class", "pseudo-element"],
      style: { color: "#a8c97f" },
    },
    {
      types: ["constant", "symbol"],
      style: { color: "#e0a76a" },
    },
    {
      types: ["deleted"],
      style: { color: "#e06c6c" },
    },
    {
      types: ["inserted"],
      style: { color: "#a8c97f" },
    },
    {
      types: ["changed"],
      style: { color: "#d4af37" },
    },
  ],
};

export default theme;

import type { Content } from "mdast";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import type { CodeChunk } from "../../../../../types.js";
import type { CodeChunker } from "../../base.js";
import { CharacterChunker } from "../../character.js";

interface HeadingInfo {
  depth: number;
  text: string;
  startLine: number;
  endLine: number;
}

interface CodeBlockInfo {
  lang: string | undefined;
  value: string;
  startLine: number;
  endLine: number;
}

/** Heuristic regex for detecting unlabeled Mermaid code blocks */
const MERMAID_KEYWORDS =
  /(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|subgraph)/;

/** Section heading depth — h1/h2 are section boundaries, h3+ rolls up */
const SECTION_HEADING_DEPTH = 2;

/** Minimum chars for a code block to become its own chunk */
const MIN_CODE_BLOCK_SIZE = 50;

/** Minimum chars for a section or preamble chunk */
const MIN_SECTION_SIZE = 50;

export class MarkdownChunker {
  private readonly config: { maxChunkSize: number };
  private readonly fallbackChunker: CodeChunker;

  constructor(config: { maxChunkSize: number }, fallbackChunker?: CodeChunker) {
    this.config = config;
    this.fallbackChunker =
      fallbackChunker ??
      new CharacterChunker({
        chunkSize: Math.floor(config.maxChunkSize / 2),
        chunkOverlap: 300,
        maxChunkSize: config.maxChunkSize,
      });
  }

  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const lines = code.split("\n");

    // Parse with frontmatter support
    const tree = remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]).parse(code);

    const headings = this.collectHeadings(tree.children);
    const codeBlocks = this.collectCodeBlocks(tree.children);
    const sectionHeadings = headings.filter((h) => h.depth <= SECTION_HEADING_DEPTH);

    // ALL code block line ranges excluded from section prose (regardless of size)
    const codeBlockLineRanges = codeBlocks.map((b) => ({ startLine: b.startLine, endLine: b.endLine }));

    // Create section chunks (prose only — code blocks excluded)
    for (let i = 0; i < sectionHeadings.length; i++) {
      const heading = sectionHeadings[i];
      const sectionEndLine = i + 1 < sectionHeadings.length ? sectionHeadings[i + 1].startLine - 1 : lines.length;

      // Extract section lines, excluding code block ranges
      const sectionLines: string[] = [];
      for (let line = heading.startLine - 1; line < sectionEndLine; line++) {
        const lineNum = line + 1; // 1-based
        const inCodeBlock = codeBlockLineRanges.some((r) => lineNum >= r.startLine && lineNum <= r.endLine);
        if (!inCodeBlock) {
          sectionLines.push(lines[line]);
        }
      }
      const sectionContent = sectionLines.join("\n").trim();

      if (sectionContent.length < MIN_SECTION_SIZE) continue;

      // Oversized section -> fallback
      if (sectionContent.length > this.config.maxChunkSize * 2) {
        const subChunks = await this.fallbackChunker.chunk(sectionContent, filePath, language);
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            startLine: heading.startLine + subChunk.startLine - 1,
            endLine: heading.startLine + subChunk.endLine - 1,
            metadata: {
              ...subChunk.metadata,
              chunkIndex: chunks.length,
              name: heading.text,
              parentName: heading.text,
              parentType: `h${heading.depth}`,
              isDocumentation: true,
            },
          });
        }
        continue;
      }

      chunks.push({
        content: sectionContent,
        startLine: heading.startLine,
        endLine: sectionEndLine,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: "block",
          name: heading.text,
          symbolId: heading.text,
          isDocumentation: true,
        },
      });
    }

    // Create code block chunks with parentName
    for (const block of codeBlocks) {
      if (block.value.length < MIN_CODE_BLOCK_SIZE) continue;
      if (this.isMermaid(block)) continue;

      const parentHeading = this.findNearestHeading(sectionHeadings, block.startLine);
      const codeBlockName = block.lang ? `Code: ${block.lang}` : "Code block";

      chunks.push({
        content: block.value,
        startLine: block.startLine + 1, // skip ``` line
        endLine: block.endLine - 1, // skip closing ```
        metadata: {
          filePath,
          language: block.lang || "code",
          chunkIndex: chunks.length,
          chunkType: "block",
          name: codeBlockName,
          symbolId: codeBlockName,
          isDocumentation: true,
          ...(parentHeading && {
            parentName: parentHeading.text,
            parentType: `h${parentHeading.depth}`,
          }),
        },
      });
    }

    // Handle preamble (content before first section heading, after frontmatter)
    if (sectionHeadings.length > 0) {
      // Find where actual content starts (after frontmatter)
      const firstContentLine = this.findFirstContentLine(tree.children);
      const preambleEndLine = sectionHeadings[0].startLine - 1;

      if (firstContentLine > 0 && firstContentLine <= preambleEndLine) {
        const preambleLines: string[] = [];
        for (let line = firstContentLine - 1; line < preambleEndLine; line++) {
          const lineNum = line + 1;
          const inCodeBlock = codeBlockLineRanges.some((r) => lineNum >= r.startLine && lineNum <= r.endLine);
          if (!inCodeBlock) {
            preambleLines.push(lines[line]);
          }
        }
        const preamble = preambleLines.join("\n").trim();

        if (preamble.length >= MIN_SECTION_SIZE) {
          chunks.unshift({
            content: preamble,
            startLine: firstContentLine,
            endLine: preambleEndLine,
            metadata: {
              filePath,
              language,
              chunkIndex: 0,
              chunkType: "block",
              name: "Preamble",
              symbolId: "Preamble",
              isDocumentation: true,
            },
          });
          // Re-index
          for (let i = 1; i < chunks.length; i++) {
            chunks[i].metadata.chunkIndex = i;
          }
        }
      }
    }

    // Whole-document fallback
    if (chunks.length === 0 && code.length >= MIN_SECTION_SIZE) {
      chunks.push({
        content: code.trim(),
        startLine: 1,
        endLine: lines.length,
        metadata: {
          filePath,
          language,
          chunkIndex: 0,
          chunkType: "block",
          isDocumentation: true,
        },
      });
    }

    return chunks;
  }

  // --- Private helpers ---

  private collectHeadings(children: Content[]): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    for (const node of children) {
      if (node.type === "heading" && node.position) {
        headings.push({
          depth: node.depth,
          text: this.extractText(node),
          startLine: node.position.start.line,
          endLine: node.position.end.line,
        });
      }
    }
    return headings;
  }

  private collectCodeBlocks(children: Content[]): CodeBlockInfo[] {
    const blocks: CodeBlockInfo[] = [];
    const collect = (node: Content) => {
      if (node.type === "code" && node.position) {
        blocks.push({
          lang: node.lang || undefined,
          value: node.value,
          startLine: node.position.start.line,
          endLine: node.position.end.line,
        });
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          collect(child as Content);
        }
      }
    };
    for (const child of children) {
      collect(child);
    }
    return blocks;
  }

  private extractText(node: Content): string {
    if (node.type === "text") {
      return (node as { type: "text"; value: string }).value;
    }
    if ("children" in node && Array.isArray(node.children)) {
      return node.children.map((child: Content) => this.extractText(child)).join("");
    }
    return "";
  }

  private isMermaid(block: CodeBlockInfo): boolean {
    if (block.lang === "mermaid") return true;
    // Heuristic for unlabeled Mermaid blocks
    if (!block.lang && MERMAID_KEYWORDS.test(block.value)) return true;
    return false;
  }

  private findNearestHeading(headings: HeadingInfo[], lineNum: number): HeadingInfo | undefined {
    // Find the last heading that starts before this line
    let nearest: HeadingInfo | undefined;
    for (const h of headings) {
      if (h.startLine <= lineNum) {
        nearest = h;
      } else {
        break;
      }
    }
    return nearest;
  }

  /** Find the first non-frontmatter content line (1-based) */
  private findFirstContentLine(children: Content[]): number {
    for (const node of children) {
      // Skip frontmatter nodes (type "yaml" from remark-frontmatter)
      if (node.type === "yaml") continue;
      if (node.position) return node.position.start.line;
    }
    return 0;
  }
}

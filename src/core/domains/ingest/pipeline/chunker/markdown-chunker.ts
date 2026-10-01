import type { Content } from "mdast";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import type { CodeChunk } from "../../../../types.js";
import type { CodeChunker } from "./base.js";
import { CharacterChunker } from "./character.js";
import { NestingLineSplitter } from "./nesting-line-splitter.js";

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

/** Section heading depth — h1/h2/h3 are section boundaries, h4+ rolls up */
const SECTION_HEADING_DEPTH = 3;

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

    const tree = remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]).parse(code);
    const headings = this.collectHeadings(tree.children);
    const codeBlocks = this.collectCodeBlocks(tree.children);
    const sectionHeadings = headings.filter((h) => h.depth <= SECTION_HEADING_DEPTH);
    const codeBlockLineRanges = codeBlocks.map((b) => ({ startLine: b.startLine, endLine: b.endLine }));

    const blockSpans = this.collectBlockSpans(tree.children);
    await this.buildSectionChunks(
      chunks,
      sectionHeadings,
      headings,
      lines,
      codeBlockLineRanges,
      blockSpans,
      filePath,
      language,
    );
    await this.buildCodeBlockChunks(chunks, codeBlocks, sectionHeadings, headings, filePath, language);
    this.buildPreambleChunk(
      chunks,
      tree.children,
      sectionHeadings,
      lines,
      codeBlockLineRanges,
      blockSpans,
      filePath,
      language,
    );
    this.buildWholeDocumentFallback(chunks, tree.children, lines, blockSpans, filePath, language);

    return chunks;
  }

  /** Create code block chunks, splitting oversized blocks via character fallback. */
  private async buildCodeBlockChunks(
    chunks: CodeChunk[],
    codeBlocks: CodeBlockInfo[],
    sectionHeadings: HeadingInfo[],
    allHeadings: HeadingInfo[],
    filePath: string,
    _language: string,
  ): Promise<void> {
    for (const block of codeBlocks) {
      if (block.value.length < MIN_CODE_BLOCK_SIZE) continue;
      if (this.isMermaid(block)) continue;

      const parentHeading = this.findNearestHeading(sectionHeadings, block.startLine);
      const codeBlockName = block.lang ? `Code: ${block.lang}` : "Code block";
      const codeBlockMeta = {
        name: codeBlockName,
        symbolId: codeBlockName,
        isDocumentation: true as const,
        headingPath: parentHeading ? this.buildHeadingPath(allHeadings, parentHeading) : [],
        ...(parentHeading && {
          parentSymbolId: parentHeading.text,
          parentType: `h${parentHeading.depth}`,
        }),
      };

      if (block.value.length > this.config.maxChunkSize) {
        const subChunks = await this.fallbackChunker.chunk(block.value, filePath, block.lang || "code");
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            startLine: block.startLine + 1 + subChunk.startLine - 1,
            endLine: block.startLine + 1 + subChunk.endLine - 1,
            metadata: {
              ...subChunk.metadata,
              chunkIndex: chunks.length,
              chunkType: "block",
              ...codeBlockMeta,
            },
          });
        }
        continue;
      }

      chunks.push({
        content: block.value,
        startLine: block.startLine + 1,
        endLine: block.endLine - 1,
        metadata: {
          filePath,
          language: block.lang || "code",
          chunkIndex: chunks.length,
          chunkType: "block",
          ...codeBlockMeta,
        },
      });
    }
  }

  /**
   * Extract preamble content before first section heading, after frontmatter.
   * A preamble over `maxChunkSize` is cut between its blocks like an oversized
   * section, and its parts follow the section-window convention: `name` and
   * `parentSymbolId` are "Preamble", no `symbolId`.
   */
  private buildPreambleChunk(
    chunks: CodeChunk[],
    children: Content[],
    sectionHeadings: HeadingInfo[],
    lines: string[],
    codeBlockLineRanges: { startLine: number; endLine: number }[],
    blockSpans: { startLine: number; endLine: number }[],
    filePath: string,
    language: string,
  ): void {
    if (sectionHeadings.length === 0) return;

    const firstContentLine = this.findFirstContentLine(children);
    const preambleEndLine = sectionHeadings[0].startLine - 1;

    if (firstContentLine <= 0 || firstContentLine > preambleEndLine) return;

    const preambleLines: string[] = [];
    const preambleSourceLines: number[] = [];
    for (let line = firstContentLine - 1; line < preambleEndLine; line++) {
      const lineNum = line + 1;
      const inCodeBlock = codeBlockLineRanges.some((r) => lineNum >= r.startLine && lineNum <= r.endLine);
      if (!inCodeBlock) {
        preambleLines.push(lines[line]);
        preambleSourceLines.push(lineNum);
      }
    }
    const preamble = preambleLines.join("\n").trim();

    if (preamble.length < MIN_SECTION_SIZE) return;

    const preambleChunks: CodeChunk[] =
      preamble.length > this.config.maxChunkSize
        ? this.splitSection(preambleSourceLines, lines, blockSpans, "", []).map((window) => ({
            ...window,
            metadata: {
              filePath,
              language,
              chunkIndex: 0,
              chunkType: "block",
              name: "Preamble",
              parentSymbolId: "Preamble",
              isDocumentation: true,
              headingPath: [],
            },
          }))
        : [
            {
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
                headingPath: [],
              },
            },
          ];

    chunks.unshift(...preambleChunks);
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].metadata.chunkIndex = i;
    }
  }

  /**
   * Whole-document fallback when no chunks were produced. Strips frontmatter.
   * A document over `maxChunkSize` is cut between its blocks like an oversized
   * section; the parts carry no name, as the whole-document chunk does not.
   */
  private buildWholeDocumentFallback(
    chunks: CodeChunk[],
    children: Content[],
    lines: string[],
    blockSpans: { startLine: number; endLine: number }[],
    filePath: string,
    language: string,
  ): void {
    if (chunks.length > 0) return;

    const firstContentLine = this.findFirstContentLine(children);
    const startLine = firstContentLine > 0 ? firstContentLine : 1;
    const content = lines
      .slice(startLine - 1)
      .join("\n")
      .trim();

    if (content.length < MIN_SECTION_SIZE) return;

    if (content.length > this.config.maxChunkSize) {
      const sourceLines = Array.from({ length: lines.length - startLine + 1 }, (_, i) => startLine + i);
      for (const window of this.splitSection(sourceLines, lines, blockSpans, "", [])) {
        chunks.push({
          ...window,
          metadata: {
            filePath,
            language,
            chunkIndex: chunks.length,
            chunkType: "block",
            isDocumentation: true,
            headingPath: [],
          },
        });
      }
      return;
    }

    chunks.push({
      content,
      startLine,
      endLine: lines.length,
      metadata: {
        filePath,
        language,
        chunkIndex: 0,
        chunkType: "block",
        isDocumentation: true,
        headingPath: [],
      },
    });
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
          collect(child);
        }
      }
    };
    for (const child of children) {
      collect(child);
    }
    return blocks;
  }

  /**
   * Line ranges of every multi-line block — lists, list items, tables,
   * blockquotes, paragraphs, html — at any depth. These are the units an
   * oversized section is cut between.
   */
  private collectBlockSpans(children: Content[]): { startLine: number; endLine: number }[] {
    const spans: { startLine: number; endLine: number }[] = [];
    const visit = (node: Content): void => {
      if (node.type !== "code" && node.position && node.position.end.line > node.position.start.line) {
        spans.push({ startLine: node.position.start.line, endLine: node.position.end.line });
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children as Content[]) visit(child);
      }
    };
    for (const child of children) visit(child);
    return spans;
  }

  /**
   * Cut one oversized section between its blocks (bd tea-rags-mcp-y5vx4): a
   * list, table or blockquote that fits a window is never divided, and the
   * heading row stays with the block after it. The first window opens with
   * the ancestor breadcrumb exactly as a whole section does — once (bd
   * tea-rags-mcp-308ff doubled it); every later window opens with the heading
   * path line, the only overlap between windows. A window's line range covers
   * its own rows, never that prefix.
   *
   * `sourceLines` are the section's 1-based source lines with fenced code
   * blocks already removed (they are chunked on their own).
   */
  private splitSection(
    sourceLines: number[],
    lines: string[],
    blockSpans: { startLine: number; endLine: number }[],
    breadcrumb: string,
    headingPath: { depth: number; text: string }[],
  ): { content: string; startLine: number; endLine: number }[] {
    const rows = sourceLines.map((line) => lines[line - 1]);
    const toRow = (line: number, fromEnd: boolean): number => {
      if (fromEnd) {
        let row = -1;
        for (let i = 0; i < sourceLines.length && sourceLines[i] <= line; i++) row = i;
        return row;
      }
      const row = sourceLines.findIndex((l) => l >= line);
      return row < 0 ? sourceLines.length : row;
    };
    const spans = blockSpans
      .map((s) => ({ startRow: toRow(s.startLine, false), endRow: toRow(s.endLine, true) }))
      .filter((s) => s.endRow > s.startRow);

    // An empty heading path (preamble, heading-less document) frames no window.
    const pathPrefix =
      headingPath.length > 0 ? `${headingPath.map((h) => `${"#".repeat(h.depth)} ${h.text}`).join(" > ")}\n` : "";
    const splitter = new NestingLineSplitter({
      rows,
      spans,
      capacityAt: (row) => this.config.maxChunkSize - (row === 0 ? breadcrumb.length : pathPrefix.length),
      openingRows: [0],
    });

    const windows: { content: string; startLine: number; endLine: number }[] = [];
    for (const part of splitter.split()) {
      let { startRow, endRow } = part;
      if (!part.columns) {
        while (startRow < endRow && rows[startRow].trim() === "") startRow++;
        while (endRow > startRow && rows[endRow].trim() === "") endRow--;
      }
      const body = part.columns
        ? rows[startRow].slice(part.columns.start, part.columns.end)
        : rows.slice(startRow, endRow + 1).join("\n");
      if (body.trim() === "") continue;
      windows.push({
        content: part.startRow === 0 ? breadcrumb + body : pathPrefix + body,
        startLine: sourceLines[startRow],
        endLine: sourceLines[endRow],
      });
    }
    return windows;
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

  /**
   * Build section chunks by grouping consecutive headings.
   * Small h3 sections are accumulated into parent h2 block up to maxChunkSize.
   * When accumulated content exceeds the limit, a new chunk starts at the h3 boundary.
   */
  private async buildSectionChunks(
    chunks: CodeChunk[],
    sectionHeadings: HeadingInfo[],
    allHeadings: HeadingInfo[],
    lines: string[],
    codeBlockLineRanges: { startLine: number; endLine: number }[],
    blockSpans: { startLine: number; endLine: number }[],
    filePath: string,
    language: string,
  ): Promise<void> {
    let accumContent = "";
    let accumStartLine = 0;
    let accumEndLine = 0;
    let accumName = "";
    let accumBreadcrumb = "";
    let accumHeadingPath: { depth: number; text: string }[] = [];
    /** 1-based source lines of the section that opened the accumulator, code blocks excluded. */
    let accumSourceLines: number[] = [];

    const flushAccum = async (): Promise<void> => {
      const content = accumContent.trim();
      if (content.length < MIN_SECTION_SIZE) return;

      if (content.length > this.config.maxChunkSize) {
        // Oversized → cut between blocks (bd tea-rags-mcp-y5vx4). Only a
        // single section can get here: an h3 joins the accumulator only while
        // the result still fits.
        for (const window of this.splitSection(
          accumSourceLines,
          lines,
          blockSpans,
          accumBreadcrumb,
          accumHeadingPath,
        )) {
          chunks.push({
            content: window.content,
            startLine: window.startLine,
            endLine: window.endLine,
            metadata: {
              filePath,
              language,
              chunkIndex: chunks.length,
              chunkType: "block",
              name: accumName,
              parentSymbolId: accumName,
              isDocumentation: true,
              headingPath: accumHeadingPath,
            },
          });
        }
      } else {
        chunks.push({
          content,
          startLine: accumStartLine,
          endLine: accumEndLine,
          metadata: {
            filePath,
            language,
            chunkIndex: chunks.length,
            chunkType: "block",
            name: accumName,
            symbolId: accumName,
            isDocumentation: true,
            headingPath: accumHeadingPath,
          },
        });
      }
    };

    for (let i = 0; i < sectionHeadings.length; i++) {
      const heading = sectionHeadings[i];
      const sectionEndLine = i + 1 < sectionHeadings.length ? sectionHeadings[i + 1].startLine - 1 : lines.length;

      // Extract section lines, excluding code block ranges
      const sectionLines: string[] = [];
      const sectionSourceLines: number[] = [];
      for (let line = heading.startLine - 1; line < sectionEndLine; line++) {
        const lineNum = line + 1;
        const inCodeBlock = codeBlockLineRanges.some((r) => lineNum >= r.startLine && lineNum <= r.endLine);
        if (!inCodeBlock) {
          sectionLines.push(lines[line]);
          sectionSourceLines.push(lineNum);
        }
      }
      const sectionContent = sectionLines.join("\n").trim();
      if (sectionContent.length < MIN_SECTION_SIZE) continue;

      const breadcrumb = this.buildBreadcrumb(allHeadings, heading);
      const contentWithBreadcrumb = breadcrumb + sectionContent;

      // h1/h2 always starts a new chunk
      if (heading.depth <= 2) {
        await flushAccum();
        accumContent = contentWithBreadcrumb;
        accumStartLine = heading.startLine;
        accumEndLine = sectionEndLine;
        accumName = heading.text;
        accumBreadcrumb = breadcrumb;
        accumHeadingPath = this.buildHeadingPath(allHeadings, heading);
        accumSourceLines = sectionSourceLines;
        continue;
      }

      // h3: try to append to current accumulator
      const separator = accumContent ? "\n\n" : "";
      const merged = accumContent + separator + contentWithBreadcrumb;

      if (merged.length <= this.config.maxChunkSize) {
        // Fits — accumulate
        accumContent = merged;
        accumEndLine = sectionEndLine;
        if (!accumName) {
          accumName = heading.text;
          accumStartLine = heading.startLine;
          accumBreadcrumb = breadcrumb;
          accumHeadingPath = this.buildHeadingPath(allHeadings, heading);
          accumSourceLines = sectionSourceLines;
        } else {
          // Add grouped h3 heading to path
          accumHeadingPath.push({ depth: heading.depth, text: heading.text });
        }
      } else {
        // Doesn't fit — flush current, start new with this h3
        await flushAccum();
        accumContent = contentWithBreadcrumb;
        accumStartLine = heading.startLine;
        accumEndLine = sectionEndLine;
        accumName = heading.text;
        accumBreadcrumb = breadcrumb;
        accumHeadingPath = this.buildHeadingPath(allHeadings, heading);
        accumSourceLines = sectionSourceLines;
      }
    }

    // Flush remaining
    await flushAccum();
  }

  /** Build breadcrumb from ancestor headings: "# Title > ## Section > ### Sub" */
  private buildBreadcrumb(allHeadings: HeadingInfo[], heading: HeadingInfo): string {
    const ancestors = this.collectAncestors(allHeadings, heading);
    if (ancestors.length === 0) return "";
    return `${ancestors.map((h) => `${"#".repeat(h.depth)} ${h.text}`).join(" > ")}\n`;
  }

  /** Build structured heading path: ancestors + current heading. */
  private buildHeadingPath(allHeadings: HeadingInfo[], heading: HeadingInfo): { depth: number; text: string }[] {
    const ancestors = this.collectAncestors(allHeadings, heading);
    return [...ancestors.map((h) => ({ depth: h.depth, text: h.text })), { depth: heading.depth, text: heading.text }];
  }

  /** Collect ancestor headings (shallower depth) before a given heading. */
  private collectAncestors(allHeadings: HeadingInfo[], heading: HeadingInfo): HeadingInfo[] {
    const ancestors: HeadingInfo[] = [];
    for (const h of allHeadings) {
      if (h.startLine >= heading.startLine) break;
      if (h.depth < heading.depth) {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= h.depth) {
          ancestors.pop();
        }
        ancestors.push(h);
      }
    }
    return ancestors;
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

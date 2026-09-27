#!/usr/bin/env python3
"""README diagram: the five layers of the TeaRAGs index (successor of p9-three-layers).

Writes public/five-layers.svg; render the PNG with
  rsvg-convert -z 2 public/five-layers.svg -o public/five-layers.png
"""
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "five-layers.svg")

W, H = 1180, 556
FONT = "Inter, -apple-system, Helvetica, Arial, sans-serif"
GOLD = "#A07D1C"
GREY_D = "#64748B"
TEXT = "#0F172A"
GRID = "#E2E8F0"
BG = "#FFFFFF"

LAYERS = [
    ("Semantic index", "What does this code do?",
     ["AST chunks, not N lines", "dense + BM25 hybrid search", "find by meaning, not by name"],
     ("where do we prorate", "a plan upgrade?")),
    ("Codegraph", "How is it connected?",
     ["symbols + resolved calls", "callers · callees · paths", "ambiguous ≠ guessed"],
     ("who calls this, and what", "will my change break?")),
    ("Trajectory", "How has it lived?",
     ["churn · bug fixes · owners", "fanIn · PageRank · blast radius", "labels from your percentiles"],
     ("what gets fixed every", "sprint, and whose is it?")),
    ("Architecture", "Is it laid out right?",
     ["stable → unstable deps", "imports past a facade", "co-change with no edge", "main-sequence distance"],
     ("which module border", "is drawn wrong?")),
    ("Lexicon", "What does the project call it?",
     ["how values of a type are named", "role word per directory", "synonyms · homonyms · outliers", "a verdict on every new name"],
     ("do my new names speak", "the project's language?")),
]


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main():
    p = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">',
        f'<rect width="{W}" height="{H}" fill="{BG}"/>',
        '<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">'
        f'<path d="M0,0 L8,4 L0,8 z" fill="{GREY_D}"/></marker></defs>',
        f'<text x="36" y="42" font-size="21" font-weight="700" fill="{TEXT}">TeaRAGs — five layers of one index</text>',
        f'<text x="36" y="66" font-size="13.5" fill="{GREY_D}">'
        "what the agent gets back for every question, whatever runs inside</text>",
    ]
    cx = W / 2
    p.append(f'<rect x="{cx-160}" y="86" width="320" height="50" rx="10" fill="#F8FAFC" stroke="{GRID}" stroke-width="1.5"/>')
    p.append(f'<text x="{cx}" y="108" font-size="14" font-weight="700" text-anchor="middle" fill="{TEXT}">AI coding agent</text>')
    p.append(f'<text x="{cx}" y="125" font-size="11.5" text-anchor="middle" fill="{GREY_D}">asks one question in plain language</text>')
    p.append(f'<line x1="{cx}" y1="136" x2="{cx}" y2="160" stroke="{GREY_D}" stroke-width="1.6" marker-end="url(#ah)"/>')
    p.append(f'<rect x="36" y="164" width="{W-72}" height="36" rx="8" fill="{GOLD}"/>')
    p.append(f'<text x="{cx}" y="187" font-size="14" font-weight="700" text-anchor="middle" fill="#FFFFFF">'
             "one MCP interface · skills that know which layer a task needs</text>")

    bw, gap, top, bh = 212, 12, 250, 222
    # group brackets: layers 1-3 read the code, 4-5 judge its interfaces
    groups = [(0, 2, "read the code — what it does, how it connects, how it has lived"),
              (3, 4, "judge its interfaces — borders and names")]
    for a, b, label in groups:
        x1 = 36 + a * (bw + gap)
        x2 = 36 + b * (bw + gap) + bw
        p.append(f'<line x1="{(x1+x2)/2}" y1="200" x2="{(x1+x2)/2}" y2="214" stroke="{GOLD}" stroke-width="1.6"/>')
        p.append(f'<path d="M{x1+4},238 L{x1+4},230 L{x2-4},230 L{x2-4},238" fill="none" stroke="{GOLD}" stroke-width="1.4"/>')
        p.append(f'<rect x="{(x1+x2)/2-len(label)*3.2-8}" y="214" width="{len(label)*6.4+16}" height="20" fill="{BG}"/>')
        p.append(f'<text x="{(x1+x2)/2}" y="228" font-size="12" font-weight="600" text-anchor="middle" fill="{GOLD}">{esc(label)}</text>')
    for i, (title, question, bullets, example) in enumerate(LAYERS):
        x = 36 + i * (bw + gap)
        mid = x + bw / 2
        p.append(f'<rect x="{x}" y="{top}" width="{bw}" height="{bh}" rx="12" fill="#F8FAFC" stroke="{GRID}" stroke-width="1.5"/>')
        p.append(f'<text x="{mid}" y="{top+22}" font-size="10.5" font-weight="700" text-anchor="middle" fill="{GREY_D}">LAYER {i+1}</text>')
        p.append(f'<text x="{mid}" y="{top+44}" font-size="16" font-weight="700" text-anchor="middle" fill="{TEXT}">{esc(title)}</text>')
        p.append(f'<text x="{mid}" y="{top+68}" font-size="12" font-weight="700" text-anchor="middle" fill="{GOLD}">{esc(question)}</text>')
        yy = top + 98
        for b in bullets:
            p.append(f'<circle cx="{x+16}" cy="{yy-4}" r="2.2" fill="{GREY_D}"/>')
            p.append(f'<text x="{x+24}" y="{yy}" font-size="11.5" fill="{TEXT}">{esc(b)}</text>')
            yy += 22
        ey = top + bh - 30
        p.append(f'<text x="{mid}" y="{ey}" font-size="11.5" font-style="italic" text-anchor="middle" fill="{GREY_D}">«{esc(example[0])}</text>')
        p.append(f'<text x="{mid}" y="{ey+16}" font-size="11.5" font-style="italic" text-anchor="middle" fill="{GREY_D}">{esc(example[1])}»</text>')
    by = top + bh + 18
    p.append(f'<rect x="36" y="{by}" width="{W-72}" height="36" rx="8" fill="#FBF6E4" stroke="{GOLD}" stroke-width="1.5" stroke-dasharray="6 4"/>')
    p.append(f'<text x="{cx}" y="{by+23}" font-size="13" text-anchor="middle" fill="{GOLD}">'
             "a dossier for every result: code + structure + history + ranking overlay · 100% local</text>")
    p.append("</svg>")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(p))
    print("wrote", OUT)


if __name__ == "__main__":
    main()

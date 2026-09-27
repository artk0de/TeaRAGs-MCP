#!/usr/bin/env python3
"""README diagram: Ollama on a LAN GPU box, the laptop's own chip as the fallback.

Writes public/ollama-failover.svg; render the PNG with
  rsvg-convert -z 2 public/ollama-failover.svg -o public/ollama-failover.png
Timings mirror src/core/adapters/embeddings/ollama.ts (PRIMARY_PROBE_INTERVAL_MS)
and bootstrap/config/schemas.ts (failoverConsecutiveFailures default 3).
"""
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "ollama-failover.svg")

W, H = 1180, 470
FONT = "Inter, -apple-system, Helvetica, Arial, sans-serif"
MONO = "JetBrains Mono, SF Mono, Menlo, Consolas, monospace"
GOLD = "#A07D1C"
GREY_D = "#64748B"
TEXT = "#0F172A"
GRID = "#E2E8F0"
BG = "#FFFFFF"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def box(p, x, y, w, h, fill="#F8FAFC", stroke=GRID, dashed=False):
    dash = ' stroke-dasharray="6 4"' if dashed else ""
    p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{dash}/>')


def text(p, x, y, s, size=12, weight=400, col=TEXT, anchor="start", family=None, italic=False):
    fam = f' font-family="{family}"' if family else ""
    st = ' font-style="italic"' if italic else ""
    p.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{col}" text-anchor="{anchor}"{fam}{st}>{esc(s)}</text>')


def main():
    p = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">',
        f'<rect width="{W}" height="{H}" fill="{BG}"/>',
        '<defs>'
        f'<marker id="g" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="{GOLD}"/></marker>'
        f'<marker id="s" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="{GREY_D}"/></marker>'
        '</defs>',
    ]
    text(p, 36, 42, "Embeddings on the LAN, the laptop as the fallback", 21, 700)
    text(p, 36, 66, "Ollama on any machine in your network does the heavy lifting; the laptop's own GPU or Apple chip takes over when it cannot", 13.5, col=GREY_D)

    # laptop
    lx, ly, lw, lh = 36, 96, 470, 250
    box(p, lx, ly, lw, lh)
    text(p, lx + 20, ly + 30, "Your laptop", 16, 700)
    box(p, lx + 250, ly + 50, 200, 76, fill=BG)
    text(p, lx + 350, ly + 78, "tea-rags", 14, 700, anchor="middle")
    text(p, lx + 350, ly + 96, "index · search · MCP", 11.5, col=GREY_D, anchor="middle")
    text(p, lx + 350, ly + 112, "Qdrant + DuckDB, embedded", 11.5, col=GREY_D, anchor="middle")
    box(p, lx + 20, ly + 50, 200, 76, fill="#FBF6E4", stroke=GOLD, dashed=True)
    text(p, lx + 120, ly + 78, "Ollama — fallback", 14, 700, anchor="middle")
    text(p, lx + 120, ly + 96, "laptop GPU / Apple chip", 11.5, col=GREY_D, anchor="middle")
    text(p, lx + 120, ly + 112, "localhost:11434", 11.5, col=GREY_D, anchor="middle", family=MONO)
    # fallback arrow
    p.append(f'<line x1="{lx+250}" y1="{ly+100}" x2="{lx+224}" y2="{ly+100}" stroke="{GREY_D}" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#s)"/>')
    text(p, lx + 20, ly + 160, "Your code and index never leave the laptop.", 12)
    text(p, lx + 20, ly + 180, "Only chunk text travels to the embedding host,", 12)
    text(p, lx + 20, ly + 198, "inside your own network.", 12)
    text(p, lx + 20, ly + 228, "EMBEDDING_FALLBACK_URL=http://localhost:11434", 11.5, col=GOLD, family=MONO)

    # LAN host
    rx, ry, rw, rh = 674, 96, 470, 250
    box(p, rx, ry, rw, rh, fill="#FBF6E4", stroke=GOLD)
    text(p, rx + 20, ry + 30, "Any machine on your LAN", 16, 700)
    box(p, rx + 20, ry + 50, 430, 76, fill=BG, stroke=GOLD)
    text(p, rx + 235, ry + 78, "Ollama — primary", 14, 700, anchor="middle")
    text(p, rx + 235, ry + 96, "desktop GPU, home server, a spare Mac", 11.5, col=GREY_D, anchor="middle")
    text(p, rx + 235, ry + 112, "gpu-box:11434", 11.5, col=GREY_D, anchor="middle", family=MONO)
    text(p, rx + 20, ry + 160, "A bigger GPU embeds faster, and the laptop", 12)
    text(p, rx + 20, ry + 180, "stays cool and free for the agent and your IDE.", 12)
    text(p, rx + 20, ry + 228, "EMBEDDING_BASE_URL=http://gpu-box:11434", 11.5, col=GOLD, family=MONO)

    # primary link
    p.append(f'<line x1="{lx+450}" y1="{ly+88}" x2="{rx-4}" y2="{ly+88}" stroke="{GOLD}" stroke-width="2.4" marker-end="url(#g)"/>')
    text(p, (lx + 450 + rx) / 2, ly + 78, "embed calls over the LAN", 11, 700, GOLD, "middle")

    # rules
    by = 364
    box(p, 36, by, W - 72, 86, fill="#F8FAFC")
    rules = [
        ("→ fallback", "the primary is unreachable, or 3 embed calls in a row fail on its side (timeout, 5xx, empty answer)"),
        ("→ primary", "while on the fallback, the primary is probed every 30 s; the first healthy answer switches back"),
        ("never counts", "caller-side errors — context overflow, missing model — would fail on any host, so they switch nothing"),
    ]
    yy = by + 26
    for k, v in rules:
        text(p, 56, yy, k, 12.5, 700, GOLD)
        text(p, 176, yy, v, 12.5)
        yy += 24
    p.append("</svg>")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(p))
    print("wrote", OUT)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""readme-html.py README.md OUT.html: the README as one self-contained page for the disk image.

Handles the Markdown that the README uses: # headings, paragraphs, - and 1. lists, ``` code blocks,
| tables |, `code`, **bold** and [text](url) links. Links to other files of the repo are not in the
image, so they become plain text. Python 3 standard library only; no network, no external style.
"""
import html, re, sys

STYLE = """
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #ffffff; --muted: #6e6e73; --code: #f2f2f5; --rule: #d2d2d7; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #1c1c1e; --muted: #a1a1a6; --code: #2c2c2e; --rule: #3a3a3c; } }
body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem 4rem; font: 16px/1.55 -apple-system, BlinkMacSystemFont, sans-serif;
       color: var(--fg); background: var(--bg); }
h1 { font-size: 2rem; margin-top: 0; } h2 { margin-top: 2.2rem; border-bottom: 1px solid var(--rule); padding-bottom: .3rem; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: .1em .3em; border-radius: 4px; }
pre { background: var(--code); padding: .8rem 1rem; border-radius: 8px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: .4rem .6rem; text-align: left; vertical-align: top; }
a { color: inherit; }
"""


def inline(text):
    out, pos = [], 0
    for m in re.finditer(r"`([^`]+)`", text):
        out.append(spans(text[pos:m.start()]))
        out.append(f"<code>{html.escape(m.group(1))}</code>")
        pos = m.end()
    out.append(spans(text[pos:]))
    return "".join(out)


def spans(text):
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)

    def link(m):
        label, url = m.group(1), m.group(2)
        if re.match(r"(https?:|mailto:|#)", url):
            return f'<a href="{html.escape(url)}">{label}</a>'
        return label   # a file in the repo: not inside the image
    return re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, text)


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def fence(lines, i):
    """The code block whose opening ``` (maybe indented) is lines[i]: (html, next index)."""
    indent = len(lines[i]) - len(lines[i].lstrip())
    body, i = [], i + 1
    while i < len(lines) and not lines[i].lstrip().startswith("```"):
        body.append(lines[i][indent:] if lines[i][:indent].strip() == "" else lines[i])
        i += 1
    return "<pre><code>" + html.escape("\n".join(body), quote=False) + "</code></pre>", i + 1


def convert(md):
    lines, out, i, title = md.splitlines(), [], 0, "Eyes & Hands"
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("```"):
            block, i = fence(lines, i)
            out.append(block)
            continue
        m = re.match(r"(#{1,6})\s+(.*)", line)
        if m:
            n = len(m.group(1))
            if n == 1 and not out:
                title = m.group(2)
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|?[\s:|-]+\|?$", lines[i + 1]):
            head = "".join(f"<th>{inline(c)}</th>" for c in cells(line))
            rows, i = [], i + 2
            while i < len(lines) and lines[i].startswith("|"):
                rows.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells(lines[i])) + "</tr>")
                i += 1
            out.append(f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table>")
            continue
        m = re.match(r"(\s*)([-*]|\d+\.)\s+(.*)", line)
        if m:
            tag = "ol" if m.group(2)[0].isdigit() else "ul"
            items = []
            while i < len(lines):
                m = re.match(r"\s*([-*]|\d+\.)\s+(.*)", lines[i])
                if m and (m.group(1)[0].isdigit()) == (tag == "ol"):
                    items.append(inline(m.group(2)))
                elif lines[i].startswith("  ") and items and lines[i].lstrip().startswith("```"):
                    block, i = fence(lines, i)
                    items[-1] += block
                    continue
                elif lines[i].startswith("  ") and lines[i].strip() and items:
                    items[-1] += " " + inline(lines[i].strip())
                else:
                    break
                i += 1
            out.append(f"<{tag}>" + "".join(f"<li>{x}</li>" for x in items) + f"</{tag}>")
            continue
        if not line.strip():
            i += 1
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r"(```|#{1,6}\s|\||\s*([-*]|\d+\.)\s)", lines[i]):
            para.append(lines[i].strip())
            i += 1
        out.append("<p>" + inline(" ".join(para)) + "</p>")
    return title, "\n".join(out)


def main(argv):
    if len(argv) != 3:
        print("usage: readme-html.py README.md OUT.html", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as f:
        title, body = convert(f.read())
    page = (f'<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            f'<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"<title>{html.escape(title)}: Read Me First</title>\n<style>{STYLE}</style>\n</head>\n<body>\n{body}\n</body>\n</html>\n")
    with open(argv[2], "w", encoding="utf-8") as f:
        f.write(page)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

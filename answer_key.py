"""The answer key (ANSWER_KEY.md) as HTML, for the site's instructor-only page. Both versions use it.

Handles the Markdown the answer key uses: headings, paragraphs, tables, nested bullet lists, and
**bold**, *italics*, `code`, \\* and [links](https://...). Everything else is shown as plain text.
"""

import html
import re
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / "ANSWER_KEY.md"  # kept out of git, like the passwords
MISSING = """# Answer key

This copy of the game has no answer key. Write one in ANSWER_KEY.md, next to levels.py: the site shows it
to anyone who enters the instructor password.
"""


def inline(text):
    out = html.escape(text).replace("\\*", "\x00")
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\*(.+?)\*", r"<em>\1</em>", out)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', out)
    return out.replace("\x00", "*")


def render(markdown=None):
    if markdown is None:
        markdown = SOURCE.read_text() if SOURCE.exists() else MISSING
    lines = markdown.splitlines()
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif m := re.match(r"(#{1,4}) (.*)", line):
            if len(m[1]) > 1:  # the page has its own title, so the file's is left out
                out.append(f"<h{len(m[1])}>{inline(m[2])}</h{len(m[1])}>")
            i += 1
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in re.split(r"(?<!\\)\|", lines[i].strip().strip("|"))]
                if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            head = "".join(f"<th>{inline(c)}</th>" for c in rows[0])
            body = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows[1:])
            out.append(f'<div class="key-table"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')
        elif re.match(r" *- ", line):
            parts, depth = [], -1
            while i < len(lines) and (m := re.match(r"( *)- (.*)", lines[i])):
                d = min(len(m[1]) // 2, depth + 1)
                if d > depth:
                    parts.append("<ul>")
                    depth = d
                else:
                    parts.append("</li>")
                    while depth > d:
                        parts.append("</ul></li>")
                        depth -= 1
                parts.append(f"<li>{inline(m[2])}")
                i += 1
            parts.append("</li>")
            while depth > 0:
                parts.append("</ul></li>")
                depth -= 1
            out.append("".join(parts) + "</ul>")
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not re.match(r"(#{1,4} | *- |\|)", lines[i]):
                para.append(lines[i].strip())
                i += 1
            out.append(f"<p>{inline(' '.join(para))}</p>")
    return "\n".join(out)


if __name__ == "__main__":
    print(render())

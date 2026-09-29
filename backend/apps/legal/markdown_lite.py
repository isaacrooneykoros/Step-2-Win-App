"""
Tiny Markdown -> HTML converter for the legal drafts in backend/legal/*.md.

Supports what those files use: # headings, paragraphs, - / * bullet lists, 1. numbered
lists, | tables |, > blockquotes, **bold**, *italic*, `code` and [links](url). Everything
is HTML-escaped first, so the output is safe to store as LegalDocument HTML (the apps
sanitise it again before display). No dependency: requirements stay unchanged.
"""

from __future__ import annotations

import html
import re

_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+|/[^)\s]*)\)")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])")
_CODE = re.compile(r"`([^`]+)`")
_ORDERED = re.compile(r"^\d+\.\s+")


def _inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = _CODE.sub(r"<code>\1</code>", out)
    out = _LINK.sub(lambda m: f'<a href="{html.escape(m.group(2))}">{m.group(1)}</a>', out)
    out = _BOLD.sub(r"<strong>\1</strong>", out)
    out = _ITALIC.sub(r"<em>\1</em>", out)
    return out


def _table(rows: list[str]) -> str:
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    body = [r for r in cells if not all(re.fullmatch(r":?-{2,}:?", c or "--") for c in r)]
    if not body:
        return ""
    head, rest = body[0], body[1:]
    parts = ["<table><thead><tr>", *[f"<th>{_inline(c)}</th>" for c in head], "</tr></thead><tbody>"]
    for r in rest:
        parts.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>")
    parts.append("</tbody></table>")
    return "".join(parts)


def markdown_to_html(text: str) -> str:
    lines = text.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    para: list[str] = []
    list_kind: str | None = None
    list_items: list[str] = []
    table_rows: list[str] = []
    quote: list[str] = []

    def flush_para():
        if para:
            out.append(f"<p>{_inline(' '.join(p.strip() for p in para))}</p>")
            para.clear()

    def flush_list():
        nonlocal list_kind
        if list_kind:
            out.append(f"<{list_kind}>" + "".join(f"<li>{_inline(i)}</li>" for i in list_items) + f"</{list_kind}>")
            list_items.clear()
            list_kind = None

    def flush_table():
        if table_rows:
            out.append(_table(table_rows))
            table_rows.clear()

    def flush_quote():
        if quote:
            out.append(f"<blockquote>{markdown_to_html(chr(10).join(quote))}</blockquote>")
            quote.clear()

    def flush_all():
        flush_para()
        flush_list()
        flush_table()
        flush_quote()

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith(">"):
            flush_para()
            flush_list()
            flush_table()
            quote.append(stripped[1:].lstrip() if len(stripped) > 1 else "")
            continue
        flush_quote()
        if not stripped:
            flush_para()
            flush_list()
            flush_table()
            continue
        if stripped.startswith("|"):
            flush_para()
            flush_list()
            table_rows.append(stripped)
            continue
        flush_table()
        heading = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading:
            flush_all()
            level = len(heading.group(1))
            out.append(f"<h{level}>{_inline(heading.group(2))}</h{level}>")
            continue
        if re.match(r"^[-*]\s+", stripped) and not stripped.startswith("**"):
            flush_para()
            if list_kind != "ul":
                flush_list()
                list_kind = "ul"
            list_items.append(re.sub(r"^[-*]\s+", "", stripped))
            continue
        if _ORDERED.match(stripped):
            flush_para()
            if list_kind != "ol":
                flush_list()
                list_kind = "ol"
            list_items.append(_ORDERED.sub("", stripped))
            continue
        if list_kind and raw.startswith("  "):
            list_items[-1] += " " + stripped  # continuation of a list item
            continue
        flush_list()
        para.append(stripped)
    flush_all()
    return "\n".join(out)

"""Exact-character extraction from .docx.

python-docx exposes paragraphs and tables, but its `Paragraph.text` collapses
soft line breaks and loses tab/break fidelity. We walk the OOXML element tree
ourselves so every w:t, w:tab, w:br, w:cr, w:softHyphen, w:noBreakHyphen and
w:sym maps to the exact Unicode codepoint the document contains.
"""
from __future__ import annotations

from typing import Iterable

from docx import Document as DocxDocument
from docx.oxml.ns import qn

from .model import ParagraphItem, TableCell, TableItem

# OOXML element qnames we handle explicitly.
_T = qn("w:t")
_TAB = qn("w:tab")
_BR = qn("w:br")
_CR = qn("w:cr")
_SOFT_HYPHEN = qn("w:softHyphen")
_NO_BREAK_HYPHEN = qn("w:noBreakHyphen")
_SYM = qn("w:sym")
_P = qn("w:p")
_PSTYLE = qn("w:pStyle")
_PPR = qn("w:pPr")
_R = qn("w:r")


def _paragraph_text(p_elem) -> str:
    """Return the full text of a <w:p> element, exactly as authored.

    - <w:t xml:space="preserve"> text is kept verbatim.
    - <w:tab/> → '\\t'
    - <w:br/> without type → '\\n' (soft line break).
    - <w:br w:type="page"/> or "column" → '\\f' (form feed).
    - <w:cr/> → '\\r'
    - <w:softHyphen/> → U+00AD, <w:noBreakHyphen/> → U+2011
    - <w:sym w:char="HH"/> → the codepoint HH.
    """
    out: list[str] = []
    for node in p_elem.iter():
        tag = node.tag
        if tag == _T:
            if node.text is not None:
                out.append(node.text)
        elif tag == _TAB:
            out.append("\t")
        elif tag == _BR:
            btype = node.get(qn("w:type"))
            if btype in ("page", "column"):
                out.append("\f")
            else:
                out.append("\n")
        elif tag == _CR:
            out.append("\r")
        elif tag == _SOFT_HYPHEN:
            out.append("­")
        elif tag == _NO_BREAK_HYPHEN:
            out.append("‑")
        elif tag == _SYM:
            ch = node.get(qn("w:char"))
            if ch:
                try:
                    out.append(chr(int(ch, 16)))
                except ValueError:
                    pass
    return "".join(out)


def _paragraph_style(p_elem) -> str:
    ppr = p_elem.find(_PPR)
    if ppr is None:
        return "Normal"
    pstyle = ppr.find(_PSTYLE)
    if pstyle is None:
        return "Normal"
    val = pstyle.get(qn("w:val"))
    return val or "Normal"


def _iter_block_items(parent) -> Iterable:
    """Yield paragraphs and tables of the body in document order."""
    for child in parent.element.body.iterchildren():
        yield child


def extract(path: str) -> tuple[list, dict]:
    """Return (items, warnings). Items are ParagraphItem | TableItem instances."""
    doc = DocxDocument(path)
    items: list = []
    warnings: list[str] = []

    p_idx = 0
    t_idx = 0

    for elem in _iter_block_items(doc):
        if elem.tag == _P:
            text = _paragraph_text(elem)
            style = _paragraph_style(elem)
            items.append(ParagraphItem.make(p_idx, style, text))
            p_idx += 1
        elif elem.tag == qn("w:tbl"):
            cells: list[TableCell] = []
            rows = 0
            cols = 0
            for r_idx, row in enumerate(elem.iter(qn("w:tr"))):
                rows = r_idx + 1
                for c_idx, cell in enumerate(row.iter(qn("w:tc"))):
                    cols = max(cols, c_idx + 1)
                    # Concatenate the exact text of every paragraph inside the cell,
                    # separated by \n so paragraph boundaries are preserved.
                    parts: list[str] = []
                    for p_in_cell in cell.iter(_P):
                        parts.append(_paragraph_text(p_in_cell))
                    cell_text = "\n".join(parts)
                    cells.append(TableCell.make(r_idx, c_idx, cell_text))
            items.append(TableItem(
                id=f"t{t_idx:05d}",
                kind="table",
                rows=rows,
                cols=cols,
                cells=cells,
            ))
            t_idx += 1
        # Section breaks (w:sectPr) and other wrappers are ignored on purpose —
        # they carry no content characters.

    return items, {"warnings": warnings}

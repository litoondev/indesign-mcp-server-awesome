"""Text extraction from .pdf.

PDFs do not store paragraphs — only glyphs placed at coordinates. Exact
character-for-character fidelity is impossible in general (ligatures, custom
glyph encodings, missing ToUnicode maps). We use pdfplumber which groups
glyphs into lines using the font metrics, and emit one PageItem per page with
the lines joined by '\\n'. A warning is attached so callers know the output
is a best-effort reconstruction, not a round-trip source of truth.
"""
from __future__ import annotations

import pdfplumber

from .model import PageItem


_PDF_WARNING = (
    "pdf: character-exact extraction is not guaranteed. Ligatures, missing "
    "ToUnicode maps and custom encodings can drop or alter characters. Verify "
    "against the source docx/xlsx when available."
)


def extract(path: str) -> tuple[list, dict]:
    items: list = []
    warnings: list[str] = [_PDF_WARNING]
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            items.append(
                PageItem(
                    id=f"pg{i:04d}",
                    kind="page",
                    page_number=i + 1,
                    text=text,
                    codepoints=len(text),
                    sha256=__import__("hashlib").sha256(text.encode("utf-8")).hexdigest(),
                )
            )
    return items, {"warnings": warnings}

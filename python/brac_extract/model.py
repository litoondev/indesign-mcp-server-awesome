from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from typing import Any, Literal


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


@dataclass
class ParagraphItem:
    id: str
    kind: Literal["paragraph"]
    style: str
    text: str
    codepoints: int
    sha256: str

    @classmethod
    def make(cls, idx: int, style: str, text: str) -> "ParagraphItem":
        return cls(
            id=f"p{idx:05d}",
            kind="paragraph",
            style=style,
            text=text,
            codepoints=len(text),
            sha256=sha256_text(text),
        )


@dataclass
class TableCell:
    r: int
    c: int
    text: str
    codepoints: int
    sha256: str
    # Preserve the original openpyxl number_format for xlsx cells (None for docx).
    number_format: str | None = None

    @classmethod
    def make(cls, r: int, c: int, text: str, number_format: str | None = None) -> "TableCell":
        return cls(
            r=r,
            c=c,
            text=text,
            codepoints=len(text),
            sha256=sha256_text(text),
            number_format=number_format,
        )


@dataclass
class TableItem:
    id: str
    kind: Literal["table"]
    rows: int
    cols: int
    cells: list[TableCell]


@dataclass
class SheetItem:
    id: str
    kind: Literal["sheet"]
    name: str
    rows: int
    cols: int
    cells: list[TableCell]


@dataclass
class PageItem:
    id: str
    kind: Literal["page"]
    page_number: int
    text: str
    codepoints: int
    sha256: str


@dataclass
class SourceMeta:
    path: str
    kind: Literal["docx", "xlsx", "pdf"]
    sha256: str
    size_bytes: int


@dataclass
class ExtractorMeta:
    extractor: str
    version: str
    python_version: str
    extracted_at: str
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class Document:
    source: SourceMeta
    meta: ExtractorMeta
    items: list[Any] = field(default_factory=list)

    def totals(self) -> dict[str, Any]:
        total_cp = 0
        composite = hashlib.sha256()
        for it in self.items:
            if isinstance(it, (ParagraphItem, PageItem)):
                total_cp += it.codepoints
                composite.update(it.sha256.encode("ascii"))
            elif isinstance(it, (TableItem, SheetItem)):
                for cell in it.cells:
                    total_cp += cell.codepoints
                    composite.update(cell.sha256.encode("ascii"))
        return {
            "items": len(self.items),
            "codepoints": total_cp,
            "sha256": composite.hexdigest(),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": asdict(self.source),
            "meta": asdict(self.meta),
            "items": [asdict(x) for x in self.items],
            "totals": self.totals(),
        }

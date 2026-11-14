"""Exact-value extraction from .xlsx.

openpyxl exposes the raw cell value (what the formula bar shows) separately
from the number-formatted display. We emit the raw value as the authoritative
text, plus the original number_format so a downstream placer can re-apply the
same display format if it chooses.
"""
from __future__ import annotations

from datetime import datetime, date, time, timedelta

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter  # noqa: F401 — re-exported for callers

from .model import SheetItem, TableCell


def _cell_text(value) -> str:
    """Convert a raw cell value into the exact Unicode string the sheet holds.

    - str → str (verbatim; newlines kept).
    - int/float → str(value) without scientific notation reformat beyond Python's default.
    - bool → "TRUE" / "FALSE" (Excel convention).
    - datetime/date/time → ISO 8601.
    - None / empty → "".
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (datetime,)):
        return value.isoformat(sep=" ")
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    if isinstance(value, float):
        # Preserve integer-valued floats as "123" (matches Excel formula bar).
        if value.is_integer():
            return str(int(value))
        return repr(value)
    return str(value)


def extract(path: str) -> tuple[list, dict]:
    """Return (items, warnings). One SheetItem per non-empty worksheet."""
    wb = load_workbook(path, data_only=True, read_only=False)
    items: list = []
    warnings: list[str] = []

    for s_idx, ws in enumerate(wb.worksheets):
        cells: list[TableCell] = []
        max_row = ws.max_row or 0
        max_col = ws.max_column or 0
        if max_row == 0 or max_col == 0:
            items.append(SheetItem(id=f"s{s_idx:03d}", kind="sheet", name=ws.title, rows=0, cols=0, cells=[]))
            continue
        for row in ws.iter_rows(min_row=1, max_row=max_row, min_col=1, max_col=max_col):
            for cell in row:
                text = _cell_text(cell.value)
                nf = cell.number_format if cell.number_format and cell.number_format != "General" else None
                if text == "" and nf is None:
                    continue  # skip truly empty cells to keep output small
                cells.append(
                    TableCell.make(
                        r=cell.row - 1,
                        c=cell.column - 1,
                        text=text,
                        number_format=nf,
                    )
                )
        items.append(SheetItem(
            id=f"s{s_idx:03d}",
            kind="sheet",
            name=ws.title,
            rows=max_row,
            cols=max_col,
            cells=cells,
        ))

    wb.close()
    return items, {"warnings": warnings}

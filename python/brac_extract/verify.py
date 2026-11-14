"""Roundtrip verifier.

Given a JSON extraction, re-extract the source file in a second pass and
compare SHA-256 hashes item-by-item. A mismatch means the extractor is not
deterministic or the source changed between the two reads.
"""
from __future__ import annotations

import json
from typing import Any

from . import docx_reader, xlsx_reader, pdf_reader
from .model import Document


_READERS = {"docx": docx_reader, "xlsx": xlsx_reader, "pdf": pdf_reader}


def _items_hash_map(items: list[dict[str, Any]]) -> dict[str, str]:
    """Flatten items into {item_id[/r,c]: sha256}."""
    out: dict[str, str] = {}
    for it in items:
        kind = it.get("kind")
        if kind in ("paragraph", "page"):
            out[it["id"]] = it["sha256"]
        elif kind in ("table", "sheet"):
            for cell in it.get("cells", []):
                out[f"{it['id']}/{cell['r']},{cell['c']}"] = cell["sha256"]
    return out


def reextract(json_path: str) -> tuple[bool, list[str]]:
    """Re-run extraction on the same source and compare hashes.

    Returns (ok, mismatches) where mismatches is a list of human-readable lines.
    """
    with open(json_path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    source = doc["source"]
    kind = source["kind"]
    reader = _READERS.get(kind)
    if reader is None:
        return False, [f"unknown source kind: {kind}"]

    new_items, _ = reader.extract(source["path"])
    new_map = _items_hash_map([
        (x.to_dict() if hasattr(x, "to_dict") else _dc_to_dict(x)) for x in new_items
    ])
    old_map = _items_hash_map(doc["items"])

    mismatches: list[str] = []
    for k, v in old_map.items():
        nv = new_map.get(k)
        if nv is None:
            mismatches.append(f"missing on reextract: {k}")
        elif nv != v:
            mismatches.append(f"sha mismatch at {k}: was {v[:12]} now {nv[:12]}")
    for k in new_map:
        if k not in old_map:
            mismatches.append(f"new on reextract: {k}")
    return (not mismatches), mismatches


def _dc_to_dict(obj) -> dict:
    from dataclasses import asdict
    return asdict(obj)

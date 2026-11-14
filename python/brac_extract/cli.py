"""Command-line entry for brac-extract.

Usage:
  py -m brac_extract <source> [--out OUT.json] [--verify]
  py -m brac_extract --verify-json OUT.json

The source kind is picked from the file extension (.docx/.xlsx/.pdf).
Exit codes:
  0 — success
  2 — extraction error
  3 — verification mismatch
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
from datetime import datetime, timezone

from . import __version__
from . import docx_reader, xlsx_reader, pdf_reader, verify
from .model import Document, ExtractorMeta, SourceMeta


_READERS = {".docx": ("docx", docx_reader), ".xlsx": ("xlsx", xlsx_reader), ".pdf": ("pdf", pdf_reader)}


def _file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_file(src: str) -> Document:
    ext = os.path.splitext(src)[1].lower()
    pair = _READERS.get(ext)
    if pair is None:
        raise SystemExit(f"unsupported extension: {ext}")
    kind, reader = pair
    items, info = reader.extract(src)
    doc = Document(
        source=SourceMeta(
            path=os.path.abspath(src),
            kind=kind,
            sha256=_file_sha256(src),
            size_bytes=os.path.getsize(src),
        ),
        meta=ExtractorMeta(
            extractor="brac_extract",
            version=__version__,
            python_version=platform.python_version(),
            extracted_at=datetime.now(timezone.utc).isoformat(),
            options={"warnings": info.get("warnings", [])},
        ),
        items=items,
    )
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="brac-extract", description="Exact-character content extractor for InDesign MCP")
    ap.add_argument("source", nargs="?", help="Path to .docx/.xlsx/.pdf")
    ap.add_argument("--out", help="Write JSON here (default: stdout)")
    ap.add_argument("--verify", action="store_true", help="After extracting, re-extract and compare hashes")
    ap.add_argument("--verify-json", help="Verify an existing extraction JSON instead of extracting")
    args = ap.parse_args(argv)

    if args.verify_json:
        ok, mismatches = verify.reextract(args.verify_json)
        if ok:
            print(json.dumps({"ok": True, "mismatches": []}))
            return 0
        print(json.dumps({"ok": False, "mismatches": mismatches}, indent=2))
        return 3

    if not args.source:
        ap.error("source is required unless --verify-json is given")

    try:
        doc = extract_file(args.source)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 2

    payload = doc.to_dict()
    text = json.dumps(payload, ensure_ascii=False, indent=2)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(json.dumps({"ok": True, "out": os.path.abspath(args.out), "items": payload["totals"]["items"], "codepoints": payload["totals"]["codepoints"], "sha256": payload["totals"]["sha256"]}))
    else:
        sys.stdout.write(text)

    if args.verify and args.out:
        ok, mismatches = verify.reextract(args.out)
        if not ok:
            print(json.dumps({"ok": False, "mismatches": mismatches}, indent=2), file=sys.stderr)
            return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

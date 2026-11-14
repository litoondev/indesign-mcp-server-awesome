# brac_extract

Exact-character content reader for the InDesign MCP pipeline.

Reads `.docx`, `.xlsx` and `.pdf` and writes a JSON file where every paragraph,
cell and page carries its own SHA-256. The downstream `replace_paragraphs` /
`replace_contact_block` tools in this repo can then place the content into
InDesign knowing the input is byte-identical to the source.

## What it preserves

- **.docx** — walks the OOXML tree directly, so `w:t` text, `w:tab`, `w:br`
  (page / line), `w:cr`, `w:softHyphen` (U+00AD), `w:noBreakHyphen` (U+2011)
  and `w:sym` all land as the right codepoint. Trailing spaces inside
  `xml:space="preserve"` runs are kept.
- **.xlsx** — raw `cell.value` from openpyxl, with `TRUE`/`FALSE`, ISO dates
  and non-scientific numbers. The original `number_format` is kept on each
  cell so a placer can re-apply the display format.
- **.pdf** — pdfplumber per-page text. Not character-exact by nature (PDFs
  have no text stream) — a warning is set on the extraction JSON and callers
  should verify against the source docx/xlsx when one exists.

## Install

```bash
py -m pip install -r python/requirements.txt
```

## CLI

```bash
# Extract one file to JSON
PYTHONPATH=python py -m brac_extract <source.docx> --out out.json --verify

# Verify an existing JSON against the current source
PYTHONPATH=python py -m brac_extract --verify-json out.json
```

Exit codes: `0` ok, `2` extract error, `3` verify mismatch.

## MCP tools

Registered on the InDesign MCP server (see `src/tools/extract.ts`):

| Tool | What it does |
|---|---|
| `extract_source` | Shell to the CLI, write JSON into `test_output/extract/`, return `{out, items, codepoints, sha256}`. |
| `read_extracted` | Load a JSON and return items filtered by `kind` / `idPrefix` / `limit`. |
| `verify_extracted` | Re-run extraction and report any item whose SHA-256 drifted. |

None of these three touch an open InDesign document, so they are safe to run
whenever — no `document_id` needed.

## JSON schema (summary)

```json
{
  "source": {"path":"...", "kind":"docx|xlsx|pdf", "sha256":"...", "size_bytes":123},
  "meta": {"extractor":"brac_extract", "version":"0.1.0", "python_version":"...", "extracted_at":"ISO", "options":{"warnings":[]}},
  "items": [
    {"id":"p00000", "kind":"paragraph", "style":"Normal", "text":"...", "codepoints":42, "sha256":"..."},
    {"id":"t00000", "kind":"table", "rows":7, "cols":3,
     "cells":[{"r":0,"c":0,"text":"...","codepoints":5,"sha256":"...", "number_format":null}]},
    {"id":"s000", "kind":"sheet", "name":"Sheet1", "rows":50, "cols":4, "cells":[...]},
    {"id":"pg0000", "kind":"page", "page_number":1, "text":"...", "codepoints":512, "sha256":"..."}
  ],
  "totals": {"items":35, "codepoints":26238, "sha256":"<composite>"}
}
```

## Design rules

- Never mutate the source file.
- Never write outside `INDESIGN_MCP_WRITE_ROOTS` (the TS wrapper enforces this;
  the Python CLI writes to whatever `--out` points at — call it under a write
  root).
- Hash everything. If a byte changes, `verify` catches it.

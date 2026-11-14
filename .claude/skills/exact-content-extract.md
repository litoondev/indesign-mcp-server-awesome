# Skill: exact content extract (Python pipeline)

Use when you need to move content from a `.docx`, `.xlsx` or `.pdf` into the
BRAC referral book (or any InDesign document) WITHOUT losing a single
character — not a comma, full stop, soft hyphen or trailing space.

## Why this exists

The older TS DOCX reader in `src/tools/content.ts` goes through mammoth HTML,
which normalises whitespace and loses some OOXML details. The Python
extractor in `python/brac_extract/` walks the OOXML tree directly and attaches
a SHA-256 to every paragraph / cell / page.

## Steps

1. **Extract.** Call the `extract_source` MCP tool with the full absolute path
   to the source file. It writes JSON into `test_output/extract/<stem>.json`
   and verifies the roundtrip. If `verify` fails, STOP — do not place anything.

2. **Inspect.** Use `read_extracted` with `kind` / `idPrefix` / `limit` to
   look at the pieces. Paragraph ids are `p00000`, tables `t00000`, sheets
   `s000`, PDF pages `pg0000`.

3. **Place.** Pass the `text` field of each item (verbatim — do NOT strip,
   reflow or re-encode) to the existing content tools:
   - `replace_paragraphs` for prose paragraph blocks.
   - `replace_contact_block` for Provider/Address/Phone groups.
   - `set_cell_text` / table tools for table cells.

4. **Re-verify before closing.** If the source file was edited mid-run,
   `verify_extracted` catches drift by re-running extraction and comparing the
   per-item SHA-256.

## Rules

- NEVER hand-type content from the source. Always go through the JSON.
- NEVER mutate the JSON. Its SHA-256 is the contract.
- NEVER call `extract_source` on a file outside the project's `content/`,
  `test_fixtures/` or an explicit input the user named. The Python extractor
  does not write to the source, but reading it still counts as a touch.
- PDF extraction is best-effort. Prefer `.docx`/`.xlsx` whenever both exist.
- If `replace_paragraphs` reports `applied:false, rolledBack:true` after
  placing an extracted paragraph, the content caused overset — fix layout or
  call `continue_story`; DO NOT edit the text to make it fit.

## Install

```bash
py -m pip install -r python/requirements.txt
```

# Skill: Reference Design — new document or pages that match a reference design

Use this when the user gives a reference .indd (or a spec) and wants a new design that matches it. **For BRAC, do not rebuild from scratch.** A new chapter is built by duplicating the designed chapter (`master-template.md` Part A), and the design DNA is in `brac-referral-template.md`. The hard rules and the Forbidden list in `content-replace.md` apply here too.

## Steps
1. **Set up.** Run `probe_indesign`. Copy the reference into `test_fixtures\runs\<label>.indd` and `open_document` the copy (read-only analysis is fine).
   - If you will change the copy, run `backup_document` before the first change.
   - Pass `document_id` (the full path) on every call.
2. **Read the source content.** Use `parse_content_file` (DOCX/CSV/XLSX/TXT). Start `test_output\runs\<label>\mismatch_notes.md`.
3. **Record the design DNA** from the reference with read-only tools:
   - `get_document_preferences` (size, margins, facing pages, bleed);
   - `list_master_spreads`, `list_paragraph_styles` / `list_character_styles` / `list_object_styles` / `list_grep_styles` (style groups are included, so use group paths);
   - `list_swatches`;
   - `snapshot_document {pageRange}` for one example of each page type, at most 4 pages per call (1-based). It gives frame bounds in pt, the effective bold/roman segments, anchored icons and tabs.
   Write down every page type, its frames, and the bold/roman pattern for each style.
4. **Prefer reuse over recreation.** If the reference document can be the base, duplicate its pages (`duplicate_page` with `spread:true` and `keepSide:true`), its masters (`duplicate_master_spread`) and its styles (`create_paragraph_style {duplicateFrom, groupPath}`), and recolour with `theme_chapter` / `swap_swatch_in_scope`. That keeps fonts, GREP and nested styles, and anchored icons exactly the same.
   Build a new document only when the user asks for one:
   1. `create_document` with the same size, margins and facing pages.
   2. Bring the styles in with `import_styles` from the reference, not by retyping values. Use `create_color_swatch` only for missing colours.
   3. Masters: `create_master_spread`, then add items with `create_text_frame`, `create_rectangle` and `create_line`. Bounds are **page-relative points**, and `pageIndex` is required.
   4. Page frames: `create_text_frame`, then `thread_text_frames`, then `name_text_frames`. Frames must not overlap existing items.
5. **Fill the content** with the content-replace step-6 loop: `replace_contact_block`, then `replace_paragraphs` (dryRun first), then `verify_page_invariants` against a baseline after **every** page, then `export_jpeg`. Writes that would hide text are rolled back by default; for intended overflow pass `allowOverset:true` and call `continue_story` straight after (content-replace step 6.7).
   - Use `apply_template_content` only for strict 1:1 frame mapping.
   - Images: `place_image {pageIndex, filePath, bounds}`, then `fit_image`. Check the PPI with `list_images` and warn below 150.
6. **Quality check.**
   - `check_overset_text`, `verify_page_invariants` on all pages (16 per call), `batch_preflight`, and `get_document_fonts`.
   - Compare the JPEGs side by side with the reference pages.
   - Report the mismatch notes.
7. **Save or close.** `save_document {filePath:<under test_output or test_fixtures\runs>}` only when asked; otherwise `close_document {save:'no'}`.

## Do not
- Retype style values from screenshots when `import_styles` or duplicating can copy them.
- Use `run_script` to build or fill content; it is for read-only inspection only.
- Use `itemByName` in scripts, or loop per character over the whole document.
- Shrink fonts (`fit_text_to_frame` allowShrink) or move items to make text fit.
- Save outside the write roots, or touch the test master or Downloads.

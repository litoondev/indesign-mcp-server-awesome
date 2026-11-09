# Skill: Content Replace — new content into an existing design, layout and formatting unchanged

Use this when the user wants the text of existing pages replaced, for example "replace Chapter 1 with the new Financial Services content". For BRAC, read `brac-referral-template.md` first; it holds the ids, styles and traps. A new chapter is a different job: use `master-template.md`.

## Hard rules (the user's, non-negotiable)
- No hidden or overset text.
- No omitted content.
- Gaps are preserved.
- Nothing extends past the margins.
- The bold/roman pattern is exact.
- Icons, anchored objects, tabs and line breaks are kept.
- Overflow cascades to the next page. It never overlaps.
- When content does not fit the template structure, **write a mismatch note. Do not guess.**

## Forbidden (each of these damaged the book before)
- Mutating `run_script` on content. That includes `story.contents = ...`, `paragraph.contents = ...`, `texts[0].contents = ...`, and rewriting a whole story or frame. `run_script` is for **read-only** inspection of a few ids only.
- Per-character loops over the whole document or story, and `allPageItems` scans in loops.
- `itemByName(...)` in scripts. Use ids from `snapshot_document`, or style paths passed to tools.
- `set_text_frame_content` with `mode:'replace_all_plain'`, `place_text_file` with `replaceStory`, and `import_word` into the book.
- Unscoped `find_replace_text`.
- `fit_text_to_frame` with `allowShrink`.
- Moving or resizing items to make text fit. Exceptions: an unthreaded single frame (step 6.7) and aligning a frame that `continue_story` added (step 6.7).
- `cascade_reflow`. It is a deprecated alias of `continue_story`; call `continue_story`.
- Keeping overset text: never pass `allowOverset:true` unless the very next call is `continue_story` on that story.
- `format_text` to "re-bold". `replace_paragraphs` label/value keeps the formatting.
- Saving over the user's file, Save As outside the write roots, saving without a backup, and opening the test master or anything in Downloads.
- Relinking or deleting the 3 missing links.

## Service-by-service workflow (chapter with multiple providers)

A chapter story often holds multiple services, each opening with a **Part Heading** paragraph. Work on them one at a time:

1. `list_chapter_services {storyId}` — returns `[{serviceIndex, partHeadingText, providerName, startParagraphIndex, endParagraphIndex}, ...]`.
2. For each service, pass `serviceIndex: N` to `replace_paragraphs` and `replace_contact_block`. The `paragraphIndex` in every edit is then **service-relative** (0 = first paragraph of that service). The tool resolves the absolute offset automatically via Part Heading boundaries.
3. Process services in order (0, 1, 2, …) and verify each before moving to the next. Never mix absolute and relative indexes in the same call.

If the story uses a non-standard style name, pass `partHeadingStyleId` or `partHeadingStyleName` to both `list_chapter_services` and `replace_paragraphs`.

## Steps
1. **Check InDesign.** Call `probe_indesign`.
   - If any call returns `EXECUTION_TIMEOUT_STILL_RUNNING` or `INDESIGN_BUSY`, repeat `probe_indesign` until it answers.
   - Before retrying a mutating call, check what already happened with `undo` + `expectUndoName`, or with a snapshot.
2. **Make a run copy.**
   - Copy the source .indd with PowerShell, e.g. `Copy-Item test_fixtures\BRAC_TEST_MASTER.indd test_fixtures\runs\<label>.indd`.
   - Never open the master. Never copy from or to Downloads; the user provides real books inside the write roots.
   - `open_document {filePath: <copy>}`. Pass `document_id: <full path of the copy>` on **every** later call.
3. **Back up.** Call `backup_document {document_id, label:'before-<job>'}` and keep `backupPath`.
   - For a rollback: `restore_backup {backupPath, targetPath: <copy>}`.
4. **Read the source.** Call `parse_content_file {filePath: content\v06_docx\<file>.docx}`.
   - Build a content map: provider -> section -> items (label/value split at the **first** ':'), contact lines with a type each.
   - Start `test_output\runs\<label>\mismatch_notes.md` and add a line for every item that has no clean slot.
5. **Baseline.** For the pages you will touch, run `verify_page_invariants {pageIndexes:[...]}` (0-based, at most 16) and keep the data as the baseline.
   - Also run `export_jpeg {outputPath: test_output\runs\<label>\before\, pageIndices:[...]}`.
6. **Work page by page, in reading order.** For each page P:
   1. `snapshot_document {pageRange:'<P+1>'}` (1-based, 1-2 pages). Read storyId, `storyParagraphIndex`, styles, effective segments (bold label), `colonStyleRules` and `anchoredCount`.
   2. Map this page's paragraphs to source items. Plan edits with **story-relative indexes as they are before the call**:
      - `{paragraphIndex, text}` for whole-paragraph text.
      - `{paragraphIndex, label, value}` for Label: value paragraphs.
      - `{paragraphIndex, insertAfter:true, text|label/value[, styleId]}` for extra items. Add `resetNextSpacing:true` when a spaceBefore warning appears.
      - `{paragraphIndex, delete:true, expectText}` for surplus template items. Tables also need `allowTable:true` + `expectTableRows`.
      - Before writing, check each value for a second ':'. Colon Bullets and Contact info bold up to the **last** colon, so the tools refuse such text (mismatch with `multiColon`) unless `acceptGrepEffects:true`. Split the item, or drop the extra label/scheme and note it (see the template skill §5).
   3. Contact blocks first:
      - `replace_contact_block {frameId|firstParagraphIndex, lines:[{type,text}], dryRun:true}`, then the same call for real.
      - If it reports `availableBlocks`, pick with `blockIndex`.
      - A type mismatch is a note, or an explicit `typeAliases` (e.g. `{fax:'phone'}`) / `extraIcons`. `extraIcons` only adds a type the block lacks; it cannot add a second line of a type the template already has (e.g. two phone numbers). Combine them on one line, e.g. `+880... (Helpline); +880...`, and record a note.
      - The dryRun does **not** measure line wraps or overset (`notChecked`); the real call can still roll back.
      - `wrapPolicy`: `'mismatch'` (default: a line that now wraps undoes the write), `'hangingIndent'` (indent the wrapped lines to the text), `'warn'` (keep the wrap). On a wrap mismatch retry once with `'hangingIndent'`, else note it.
      - Under every `wrapPolicy`, a write that pushes a line or following text into overset is undone: `applied:false, rolledBack:true`, mismatch `reason:'pushed into overset'` with `frameId`. Nothing needs undoing; shorten (your note) or record the mismatch.
   4. `replace_paragraphs {storyId, edits, dryRun:true}`. Fix or note every entry in `mismatches[]`, then run it for real.
      - The result must be `success:true`, `applied` not false, and empty `overrideErrors`.
      - Review `warnings` (numbering changes, spacing, icon wraps).
      - The tool undoes itself when anchors, styles or overrides change (`success:false`).
      - A write that leaves new hidden text is undone by default: `success:true, applied:false, rolledBack:true, revertedEdits`, mismatch `{kind:'overset', reason:'pushed into overset ...', frameId, singleUnthreadedFrame}`. See step 6.7.
   5. **Verify the page:** `verify_page_invariants {pageIndexes:[P, P+1], baseline}`. Judge by `baselineDiff.problems`.
      - There must be no new overlaps, margin violations, placeholder text, anchor loss or gap delta.
      - Planned style-sequence changes are fine; list them.
   6. `export_jpeg {pageIndices:[P]}` and look at it: bold labels, chapter-colour service names, an icon on every contact line, nothing clipped.
   7. **Cascade rule:** text that no longer fits flows through the existing thread to the next page; then continue with that page.
      - Never shuffle items to make room.
      - **Threaded body story that will overflow past its last frame:** the default write is rolled back, so pass `allowOverset:true` on that `replace_paragraphs` / `replace_contact_block` call, then immediately call `continue_story {storyId}`. Afterwards `check_overset_text` must show the story is no longer overset.
      - `continue_story` (and its alias `cascade_reflow`) never shrinks fonts or moves items; it adds pages with the same master and threads a new frame. Add `allowCrossSection:true` only at a chapter end, with a parity check (step 7).
      - **Known issue:** the added frame is placed at the page margin box (top 43.2 pt), about 13 pt higher than the template body frame. Compare its top with the body frame of a template page of the same side (`snapshot_document`), align it with `resize_text_frame` (same left/right/bottom, template top), then re-check overset (call `continue_story` again if text no longer fits) and `verify_page_invariants`. (`frameGeometry:'lastFrame'` copies the last frame's bounds instead; it is not harness-tested.)
      - If continue_story fails, `data.blocker` explains why (table rows, keep options). Undo the `allowOverset` write (`undo {expectUndoName:'replace_paragraphs'}` or `'replace_contact_block'`), record a note and do not force it.
      - **Unthreaded single frame** (e.g. an opener title, a provider box): a rollback with `singleUnthreadedFrame:true` left nothing to undo. Never use `allowOverset` here. Either grow that frame with `resize_text_frame` (inside the margins, template gaps kept; moving a neighbour only with `transform_item` and the user's approval) and retry, or record a mismatch. The refusal does not report the height needed: grow by one line of the style's leading at a time, retry, and confirm with `applied[].lineCountBefore/After`.
   8. If a check fails: `undo {expectUndoName:'<tool name>'}`, fix the plan, and redo that page. Never stack fixes on a broken page.
7. **Finish.**
   - `check_overset_text`: there must be nothing new compared with the baseline (story 5846's Agrani table and story 35473 are pre-existing; compare with the baseline).
   - `verify_page_invariants` on all changed pages (16 at a time) and `export_jpeg` of every changed page.
   - Do a word check: every source string is placed or listed in the notes.
   - Parity: if pages were added or removed, the next chapter opener must stay on a **right-hand** page. If it flips, record it and ask; one blank page via `add_page {at:'after', referencePageIndex, masterName:'B-Blank'}` at the chapter end is the usual remedy, with the user's approval.
8. **Save or close.**
   - Save only if the task says so: `save_document {document_id}` in place on the run copy.
   - Otherwise `close_document {document_id, save:'no'}`.
   - Confirm `list_open_documents` shows nothing of yours.
   - Report: pages changed, the mismatch notes file, the JPEG folder and the backupPath.

## Undo names
`replace_paragraphs`, `replace_contact_block`, `continue_story`, `resize_text_frame`, `MCP: Transform Item`, `apply_style`, `MCP: Delete Page`, `MCP: Add Pages`, `Find/Replace Text`. (An automatic overset rollback is already undone: do not undo again.)

# Skill: Master Template — build a new chapter from the template chapter (and .indt templates)

Use this when the user wants a new chapter built from an existing designed chapter, or wants a design turned into a reusable template. For BRAC, read `brac-referral-template.md` first. To replace text in pages that already exist, use `content-replace.md`; this skill reuses its page loop (step 6 there) and its Forbidden list, which applies here unchanged.

## Part A — New BRAC chapter from Chapter 1 (v06)
1. **Ask the user first, then wait for the answers.** Ask for:
   - the chapter number and the opener title (the book already has a "Chapter 2 / Access to Social Welfare" opener, and the TOC on page IX is static);
   - the chapter colour, an existing swatch name (see the template skill §6; never invent one; `Pantone 3298 C` was only a test colour);
   - the new master prefix and name, e.g. `W-Access to Women & Child Care`;
   - the position in the book (after which page);
   - a short running head that fits the master frame (about 3.08 in wide; `Chapter 1: Access to Finance` is the size reference).
   Record each answer in `test_output\runs\<label>\mismatch_notes.md` under "decisions".
2. **Set up.** Follow content-replace steps 1-4: `probe_indesign`, copy to `test_fixtures\runs\<label>.indd`, `open_document`, `backup_document`, and `parse_content_file` on the chapter DOCX. Pass `document_id` (the full path) on every call.
3. **Duplicate the opener.** Run `duplicate_page {pageIndex:12, toLocation:'afterPage', referencePageIndex:<last page of the preceding chapter>, keepSide:true}`.
   - The copy must be a **right-hand** page. Check `pages[0].side` and `sideChanged`.
   - Keep `newPageIds` and the new index.
4. **Duplicate the content pages, a spread at a time.** Run `duplicate_page {pageIndex:13, spread:true, toLocation:'afterPage', referencePageIndex:<last new page>, keepSide:true}`.
   - Page 13 is page 02; its spread is 02-03. Repeat until there are about enough pages; `continue_story` adds the rest later.
   - Read `threadedFrameIds` and `loremFrameIds`. The copied frames form a new story that holds only the text that was in those frames.
   - Run `verify_page_invariants` on the new pages and keep the data as the baseline.
5. **Theme the chapter** (after the pages are duplicated, so `scope` + `remapScope` re-point them to the new styles). Run `theme_chapter` with `dryRun:true` first, then for real:
   ```
   {sourceMaster:'1-Access to Finance', newNamePrefix, newBaseName,
    textReplace:[{find:'Chapter 1: Access to Finance', replace:'<short running head>'}],
    fromSwatch:'Pantone 7498 C', toSwatch:'<confirmed swatch>',
    styles:[{source:'Regular set/Color Reset/Part Heading', newName:'Part Heading <X>'},
            {source:'Regular set/Color Reset/Service Name Numbered', newName:'Service Name Numbered <X>'},
            {source:'Regular set/Color Reset/Provider Name', newName:'Provider Name <X>'},
            {styleType:'character', source:'Running head', newName:'Running head <X>'}],
    scope:{pageIndexes:[<new opener and content page indexes>]}, remapScope:true}
   ```
   What to check in the result:
   - `swap.styleChanges` includes `paragraphShadingColor` (Provider Name) and `paragraphBorderColor` (Part Heading); tints of the chapter colour are mapped to the same tint of `toSwatch`.
   - `masterAfterSwap.localRemaining` and `styleDerivedRemaining` are 0, `styleColourAudit` is empty, and there are no `styleColourNotSwapped` / `styleColourUnreadable` mismatches. A guard `swap_swatch_in_scope {..., scope:{paragraphStyleIds:[<duplicated ids>]}, overrideMode:'all', dryRun:true}` should count 0.
   - `styleColours` warnings about rule above/below colours (800/900) or an underline colour (e.g. `Pantone 2593 C`) being "neither the new chapter colour nor a source swatch" are known noise from inactive properties.
   - Running head: a `textReplace` that would overset the master frame is rolled back (`master.mismatches` type `textReplaceOverset`, action `rolledBack`). Then ask the user for (or propose) a shorter running head, write it with `replace_paragraphs {storyId:<story from the mismatch>, edits:[{paragraphIndex:0, text}]}` on the new master's story, and record a mismatch note. `verify_page_invariants` on a new content page must show empty `masterIssues`.
   - Check `offColourItems`: everything there is either fixed with a scoped `swap_swatch_in_scope` or noted.
6. **Apply the new master** to the new content pages: `apply_master {masterName:'<prefix>-<base>', pageIndices:[...]}`. The opener keeps `A-Parent`, as in the template.
7. **Opener text.**
   - Run `snapshot_document` on the new opener (1-based pageRange) to get the title and description story ids.
   - Then `replace_paragraphs` with edit 0 = `Chapter N` and edit 1 = the title, plus the description story.
   - A title too long for its single frame is refused: `applied:false, rolledBack:true`, mismatch `pushed into overset` with `singleUnthreadedFrame:true`. Nothing to undo; never use `allowOverset` here.
   - Documented fix (needs the user's approval, record it as a note): move the illustration group up with `transform_item {itemId:<group>, moveY:-<growth>}` and grow the title frame upward by the same amount with `resize_text_frame` (new top = old top − growth), staying inside the margins and keeping the 27.03 pt / 17.28 pt gaps. Then retry the `replace_paragraphs` call.
   - The refusal does not report the height needed. Grow by one line of the title leading at a time and retry until it applies; confirm with `applied[].lineCountBefore/After` (v06 job B: 2 extra lines = 57.6 pt). Never leave text overset to measure it.
   - Run `verify_page_invariants` on the opener: gaps as in the template, nothing outside the margins.
   - Record that the illustration is still Chapter 1's finance icon set (no artwork exists for the new chapter; user decision).
8. **Content, page by page.** Follow content-replace step 6 exactly: snapshot, then `replace_contact_block`, then `replace_paragraphs` (dryRun first), then `verify_page_invariants` against the baseline, then `export_jpeg`.
   - Use the duplicated (`<X>`) styles. After `remapScope` the paragraphs already use them; check with the snapshot.
   - Delete template sections the source lacks only with `expectText` (and `allowTable` + `expectTableRows` for branch tables), and note each deletion.
9. **Overflow.** As content-replace step 6.7: pass `allowOverset:true` on the write that overflows, then `continue_story {storyId:<new story>}` (adds pages with the same master after the story's last frame; never shrinks fonts or moves items). Align the added frame's top to the template body frame (known issue, see content-replace).
   - Pass `allowCrossSection:true` only when the next page is another chapter's section start.
   - Parity: the new chapter (opener included) must have an even page count so the next chapter opener stays right-hand. If it is odd, add one `B-Blank` page at the chapter end: `add_page {at:'after', referencePageIndex:<last new page>, masterName:'B-Blank'}`. Confirm with `list_pages`.
10. **Finish.**
   - Run `check_overset_text` (no new overset stories), `verify_page_invariants` on all new pages plus the pages either side, and `export_jpeg` of every new page. `find_text {findWhat:'Lorem', includeMasterPages:true}` (also `ipsum`, `Access to Finance`) must find nothing on the new pages.
   - Do a word check against the DOCX.
   - Record notes for the open user decisions: the chapter colour (if it was a test colour), chapter numbering (an existing "Chapter 2" opener is already in the book), the TOC on page IX not listing the chapter, a shortened running head, dropped URL schemes / colon labels, combined phone numbers, and the illustration.
   - Then `close_document {save:'no'}`, or `save_document` in place on the run copy if the task says so.

## Part B — Generic .indt template / pages from a template
1. Run `backup_document` first.
2. `create_template_from_page {outputPath:'test_output\...\x.indt', clearContent:true, keepImages:true}`. It works on a temporary copy; the open document is not changed. Anchors, tabs and returns are kept.
3. Fill pages with `apply_template_content {contentMap:[{frameId|frameName+pageIndex, content | edits}]}`.
   - Paragraph mapping is strict 1:1. A different paragraph count is a mismatch; record it.
4. Repeat page types with `duplicate_page_with_content {sourcePageIndex, contentMap, duplicateSpread:true}`.
   - `clone_page_layout` copies the layout only, and it clears the target page by default.
5. Verify the same way as step 10 of Part A.

## Undo names
`theme_chapter`, `swap_swatch_in_scope`, `duplicate_master_spread`, `MCP: Duplicate Page`, `MCP: Apply Master`, `replace_paragraphs`, `replace_contact_block`, `continue_story`, `resize_text_frame`, `MCP: Transform Item`, `MCP: Add Pages`.

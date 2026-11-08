# Prompt 2: Template থেকে নতুন Chapter N (color X, content file Y)

**Skill:** `.claude/skills/master-template.md` Part A (reference: `.claude/skills/brac-referral-template.md`, page loop: `.claude/skills/content-replace.md` step 6)

| Placeholder | মানে | উদাহরণ (v06 job B) |
|-------------|------|---------------------|
| `{N}` | নতুন chapter number | `2` (মনে রাখবেন: book-এ "Chapter 2" Social Welfare opener আগে থেকেই আছে। Number আর TOC নিয়ে সিদ্ধান্ত আপনার) |
| `{TITLE}` | Chapter-এর নাম | `Access to Women, Childcare, and Family Support Services` |
| `{RUNNING_HEAD}` | Master-এর running head (এক লাইনে ধরতে হবে) | `Chapter 2: Access to Women, Childcare & Family Support` |
| `{COLOR}` | নতুন chapter color swatch (আপনার নিশ্চিত করা) | `Pantone 3298 C` শুধু test-এ ব্যবহার হয়েছে; আসল রঙ আপনি ঠিক করবেন (Ch1 = `Pantone 7498 C`) |
| `{PREFIX}` / `{MASTER_BASE}` | নতুন master | `W` / `Access to Women & Child Care` |
| `{SOURCE}` | Content file | `I:\Indesign\content\v06_docx\Chapter 01 - Access to Women & Child Care & Family Support Services (5)_Phone Numbers Checked.docx` |
| `{INSERT_AFTER_INDEX}` | কোন page-এর পরে বসবে (0-based) | `23` (Chapter 1-এর শেষ content page "12") |
| `{RUN_LABEL}` | Run copy | `ch-new-women-2026-11-07` |

---

## বাংলা prompt (paste করুন)

```text
Skill: .claude/skills/master-template.md Part A follow করো (BRAC reference: .claude/skills/brac-referral-template.md)। এই prompt-এর সাথে মতভেদ হলে এই prompt চলবে। run_script দিয়ে content লেখা আর format_text দিয়ে bold/roman করা নিষেধ।

কাজ: Chapter 1 "Access to Finance"-কে template ধরে নতুন Chapter {N} "{TITLE}" বানাও। Chapter color {COLOR}, content {SOURCE} থেকে। নতুন chapter বসবে page index {INSERT_AFTER_INDEX}-এর পরে। এতে থাকবে: নতুন chapter opener (Chapter 1 opener, page XIII = index 12-এর মতো), নতুন master-এ content page, নিজের chapter color, আর একই style (duplicate করা)।

SAFETY (ভাঙা যাবে না):
- C:\Users\Litoondev\Downloads-এ কিছু ছোঁবে না। Source শুধু I:\Indesign\content\... থেকে পড়বে।
- I:\Indesign\test_fixtures\BRAC_TEST_MASTER.indd খুলবে না। Copy-Item দিয়ে I:\Indesign\test_fixtures\runs\{RUN_LABEL}.indd বানাও (আগে থেকে থাকলে থামো) আর শুধু সেখানে কাজ করো। প্রতিটা call-এ document_id = সেই full path।
- SAFETY refusal এলে থামো। Timeout বা INDESIGN_BUSY এলে শুধু probe_indesign।
- 3টা LINK_MISSING (cover EPS, page V আর VII-এর PNG) স্বাভাবিক। relink বা delete করবে না।
- Chapter 1-এর page, অন্য chapter, front matter আর TOC-এ কোনো পরিবর্তন নয়।

Content rules: Prompt 1-এর মতোই। overset বা hidden নয়, কিছু বাদ নয়, gap আর margin ঠিক, bold label: + roman value, Service Name bold {COLOR}-এ, contact = icon + tab + text, overflow cascade। না মিললে mismatch note।

ধাপগুলো এই ক্রমে (আগে page duplicate, তারপর theme):
0. probe_indesign → list_open_documents।
1. Copy-Item → open_document। Fixture যাচাই (get_active_document, list_pages, list_master_spreads): 25 pages, 6x9, master "1-Access to Finance", "A-Parent", "B-Blank", "2-Access to Social Welfare" আছে। না মিললে থামো।
2. backup_document {label: "before-new-ch{N}"}।
3. parse_content_file {filePath: {SOURCE}}।
4. list_swatches: {COLOR} আছে কিনা, আর অন্য chapter-এ ব্যবহার হয়েছে কিনা দেখো। না থাকলে থামো আর আমার কাছে মান চাও। নিজে রঙ বানাবে না বা বেছে নেবে না।
5. list_paragraph_styles, list_character_styles, list_object_styles: Chapter 1-এ "Pantone 7498 C" ব্যবহার করে এমন style-এর id নাও। কমপক্ষে: Part Heading, Service Name Numbered, Provider Name, Running head character style, আর GREP/nested-এ ব্যবহার হওয়া character style। এগুলো allParagraphStyles-এ group path সহ আছে।
6. Opener: duplicate_page {pageIndex: 12, toLocation: "afterPage", referencePageIndex: {INSERT_AFTER_INDEX}, keepSide: true}। Opener-কে right page-এ থাকতে হবে (pages[0].side, sideChanged)। keepSide refusal এলে থামো।
7. Content spread: duplicate_page {pageIndex: 13, spread: true, toLocation: "afterPage", referencePageIndex: <শেষ নতুন page index>, keepSide: true} (page "02"-"03" spread)। Content অনুযায়ী আরও entry লাগলে আবার duplicate করো। প্রতিবার newIndex, side, sideChanged, loremFrameIds আর threadedFrameIds লিখে রাখো। নতুন story-তে শুধু copy হওয়া page-এর text আছে কিনা snapshot দিয়ে দেখো। তারপর নতুন page-গুলোতে verify_page_invariants = baseline।
8. theme_chapter {sourceMaster: "1-Access to Finance", newNamePrefix: "{PREFIX}", newBaseName: "{MASTER_BASE}", textReplace: [{find: "Chapter 1: Access to Finance", replace: "{RUNNING_HEAD}"}], fromSwatch: "Pantone 7498 C", toSwatch: "{COLOR}", styles: [... প্রতিটা newName "<নাম> {PREFIX}"], scope: {pageIndexes: [নতুন opener + content page]}, remapScope: true, dryRun: true}। Result দেখাও। তারপর dryRun ছাড়া আসল call।
9. Theme-এর পরের check:
   a. swap.styleChanges-এ Provider Name-এর paragraphShadingColor আর Part Heading-এর paragraphBorderColor থাকতে হবে। masterAfterSwap.localRemaining আর styleDerivedRemaining 0, styleColourAudit খালি, styleColourNotSwapped / styleColourUnreadable mismatch নেই। যাচাই: swap_swatch_in_scope {fromSwatch: "Pantone 7498 C", toSwatch: "{COLOR}", scope: {paragraphStyleIds: [নতুন duplicate style-এর id]}, overrideMode: "all", dryRun: true} → count 0 হতে হবে। 0 না হলে থামো আর report করো।
   b. Running head: master.mismatches-এ textReplaceOverset (action rolledBack) এলে replacement আগেই ফিরিয়ে নেওয়া হয়েছে। থামো আর আমাকে একটা ছোট running head প্রস্তাব দাও। আমার OK পেলে replace_paragraphs {storyId: <mismatch-এর story>, edits: [{paragraphIndex: 0, text: <ছোট running head>}]} দিয়ে নতুন master-এর story-তে লেখো, mismatch note রাখো। নতুন content page-এ verify_page_invariants-এর masterIssues খালি হতে হবে।
   c. styleColours warning-এ rule above/below (800/900) বা underline color (যেমন Pantone 2593 C) "neither the new chapter colour nor a source swatch" — এগুলো inactive property-র জানা noise। Report-এ এক লাইনে লেখো, ঠিক করতে যাবে না।
10. apply_master {masterName: "{PREFIX}-{MASTER_BASE}", pageIndices: [নতুন content page-গুলো]}। Opener "A-Parent"-এ থাকবে। তারপর swap_swatch_in_scope {fromSwatch: "Pantone 7498 C", toSwatch: "{COLOR}", scope: {pageIndexes: [নতুন page]}, dryRun: true}: count 0 আর offColourItems খালি হওয়া উচিত; না হলে report করো (Agrani-র Pantone 2593 C icon template-এরই)।
11. Opener text: snapshot_document → replace_paragraphs: "Chapter 1" → "Chapter {N}", "Access to Finance" → "{TITLE}", আর description frame (Regular White) source-এর chapter intro দিয়ে। Title frame-এ না ধরলে tool নিজেই ফিরিয়ে নেয় (applied: false, rolledBack: true, mismatch "pushed into overset", singleUnthreadedFrame: true); undo লাগবে না, allowOverset দেবে না। তখন থামো আর অনুমতি চাও। আমার OK পেলে: transform_item দিয়ে illustration group উপরে সরাও (moveY: -growth) আর resize_text_frame দিয়ে title frame-এর top একই পরিমাণ উপরে তোলো (margin-এর ভেতরে, 27.03pt / 17.28pt gap বজায়)। Refusal দরকারি height বলে না: এক লাইন (title leading) করে বাড়াও আর আবার replace_paragraphs চালাও, যতক্ষণ না applied হয়; applied[].lineCountBefore/After দিয়ে মেলাও। Text overset রেখে মাপবে না। শেষে opener-এ verify_page_invariants।
12. Content: content-replace skill step 6 এখানে চলবে। Map দেখিয়ে আমার OK নাও। তারপর প্রতি page-এ:
    snapshot → replace_contact_block dryRun (dryRun wrap/overset মাপে না, notChecked দেখো), তারপর আসল call → line count বদলালে আবার snapshot → replace_paragraphs dryRun, তারপর আসল call → verify_page_invariants with baseline → snapshot দিয়ে bold check → export_jpeg (100 dpi, I:\Indesign\test_output\runs\{RUN_LABEL}\)।
    - Contact: wrap mismatch হলে একবার wrapPolicy "hangingIndent"। fax-এর জন্য typeAliases {fax: "phone"} বা extraIcons। একই type-এর দ্বিতীয় line (যেমন Helpline + Phone) extraIcons দিয়ে যোগ হয় না: এক phone line-এ লেখো, যেমন "+880... (Helpline); +880...", আর mismatch note রাখো।
    - ':' : Contact info GREP শেষ colon পর্যন্ত bold করে। ২+ colon বা "https://" / "Head Office:" থাকলে tool লেখে না (acceptGrepEffects ছাড়া)। acceptGrepEffects দেবে না; label/scheme বাদ দিয়ে লেখো আর mismatch note রাখো (আমার নিশ্চিত করার জন্য)।
    - Rollback: applied: false + rolledBack: true + "pushed into overset" এলে write আগেই undo হয়েছে। Single frame হলে mismatch note, থামো। Threaded body story ইচ্ছাকৃতভাবে overflow করলে ধাপ 13।
    - Template-এর বাড়তি অংশ (Documents, Various Information, branch table) delete শুধু expectText দিয়ে, table-এর জন্য allowTable + expectTableRows। Lorem বা Chapter 1-এর পুরনো text নতুন chapter-এ থাকা চলবে না।
13. Overflow: যে write story-কে শেষ frame পেরিয়ে নিয়ে যায়, সেটা allowOverset: true দিয়ে চালাও, তারপর সঙ্গে সঙ্গে continue_story {storyId}। এটা font ছোট করে না বা item সরায় না; একই master-এ page যোগ করে frame thread করে। Blocker এলে allowOverset write undo করো আর থামো। জানা সমস্যা: নতুন frame margin-এর top-এ (43.2pt) বসে, template body frame-এর চেয়ে ~13pt উপরে। snapshot দিয়ে একই side-এর template page-এর body frame top দেখো আর resize_text_frame দিয়ে মিলাও (left/right/bottom একই), তারপর check_overset_text আর verify। শেষে নতুন chapter-এর মোট page (opener সহ) জোড় হতে হবে; বিজোড় হলে add_page {at: "after", referencePageIndex: <শেষ নতুন page>, masterName: "B-Blank"} দিয়ে একটা blank page যোগ করো আর report করো। list_pages দিয়ে নিশ্চিত হও যে "2-Access to Social Welfare" opener এখনো right side-এ।
14. শেষ যাচাই: check_overset_text (নতুন overset = 0, running head সহ); find_text {findWhat: "Lorem" / "ipsum" / "Access to Finance", includeMasterPages: true} নতুন page-এ 0; verify_page_invariants নতুন সব page + Chapter 1-এর শেষ page + পরের chapter opener; source word check।
15. save_document (run copy) → close_document {save: "no"} → list_open_documents।

থামো এবং report করো, যদি:
- {COLOR} নেই বা আমি নিশ্চিত করিনি, বা কোনো style/master নাম মেলে না।
- theme_chapter dryRun-এ error আসে, বা ধাপ 9a-র check ব্যর্থ হয়।
- duplicate_page-এ keepSide refusal বা sideChanged আসে।
- Running head বা opener title rolled back হয় (ধাপ 9b / 11, আমার অনুমতি লাগবে)।
- Contact-এর type বা count mismatch, overrideErrors, বা single frame-এ overset rollback আসে।
- continue_story blocker দেয়, বা section পার হতে চায়।
- Chapter number দ্বন্দ্ব হয় (book-এ একই number-এর chapter আগে থেকে আছে)। তখন আমাকে জিজ্ঞেস করো।

Final report-এ থাকবে:
1. Run copy, backupPath, নতুন master নাম, duplicate style-এর list (পুরনো id → নতুন id)।
2. Theme result: styleChanges, swap count, ধাপ 9a-র check, textReplaceOverset, styleColours noise।
3. নতুন page-এর table: index | name | side | master | entry | edits | mismatches | verify | JPEG।
4. Parity: যোগ হওয়া page, B-Blank যোগ হয়েছে কিনা, পরের chapter opener-এর side।
5. আমার সিদ্ধান্ত লাগবে এমন mismatch notes: chapter color (test রঙ হলে), chapter number দ্বন্দ্ব, TOC (page IX-এর static table-এ নতুন chapter নেই, আমি না বললে edit করবে না), ছোট করা running head, title-এর জন্য illustration সরানো, opener illustration এখনো Chapter 1-এর finance icon (নতুন artwork নেই), বাদ দেওয়া URL scheme / colon label, এক line-এ জোড়া দেওয়া phone number, source-এর যে label বা section বাদ গেছে।
6. Overset/placeholder before vs after, source word check-এর missing list, সব undo, save আর close status।
```

---

## English version (short)

```text
Follow .claude/skills/master-template.md Part A (reference: brac-referral-template.md; page loop: content-replace.md step 6). This prompt wins on conflicts. Never write content with run_script or format_text.

Task: build Chapter {N} "{TITLE}" with colour {COLOR} from {SOURCE}, using Chapter 1 (opener XIII = index 12, content "02".."12" = 13..23) as the template, inserted after page index {INSERT_AFTER_INDEX}.

Safety: Copy-Item BRAC_TEST_MASTER.indd to I:\Indesign\test_fixtures\runs\{RUN_LABEL}.indd and work only on that copy, with document_id = its full path. Never touch Downloads. Leave the 3 LINK_MISSING links alone. Do not change Chapter 1, other chapters, the front matter or the TOC.

Steps (duplicate pages first, then theme): probe → copy/open → fixture check → backup_document → parse_content_file → list_swatches (stop and ask if {COLOR} is missing or not confirmed by me) → list styles → duplicate_page opener {pageIndex:12, toLocation:"afterPage", referencePageIndex:{INSERT_AFTER_INDEX}, keepSide:true} → duplicate_page {pageIndex:13, spread:true, toLocation:"afterPage", referencePageIndex:<last new page>, keepSide:true} as needed → baseline verify_page_invariants → theme_chapter dryRun, then the real call {sourceMaster:"1-Access to Finance", newNamePrefix:"{PREFIX}", newBaseName:"{MASTER_BASE}", textReplace running head → "{RUNNING_HEAD}", fromSwatch "Pantone 7498 C", toSwatch "{COLOR}", styles, scope:{pageIndexes:[new pages]}, remapScope:true}.

Checks after the theme: styleChanges include paragraphShadingColor (Provider Name) and paragraphBorderColor (Part Heading); masterAfterSwap remaining 0, styleColourAudit empty; a swap_swatch_in_scope dryRun on the duplicated paragraphStyleIds (overrideMode "all") counts 0. A textReplaceOverset mismatch means the running head was rolled back: propose a shorter one, and after my OK write it with replace_paragraphs on the master story (note it). styleColours warnings about inactive rule/underline colours are known noise.

Then: apply_master to the new content pages (opener stays A-Parent) → swap_swatch_in_scope dryRun on the new pages should count 0 → opener text via replace_paragraphs. A title that does not fit is rolled back (applied:false, rolledBack:true, singleUnthreadedFrame); stop and ask. With my OK, move the illustration group up with transform_item (moveY negative) and raise the title frame top by the same amount with resize_text_frame, inside the margins and keeping the template gaps; grow one line at a time and retry (the refusal does not report the height needed; never leave text overset). → content per content-replace step 6 (map + my OK; contact block dryRun then real (dryRun does not measure wraps), wrap → hangingIndent once, a second phone combined on one line, no acceptGrepEffects: drop "https://"/"Label:" and note it; replace_paragraphs dryRun then real; verify with baseline; bold check; JPEG). Intended overflow: allowOverset:true on that write, then continue_story at once; align the added frame's top with the template body frame (it starts ~13pt high at the margin) using resize_text_frame, recheck overset. The chapter page count must end up even; if odd, add_page {at:"after", referencePageIndex:<last new page>, masterName:"B-Blank"}. Final checks: overset, find_text {findWhat} Lorem/ipsum/"Access to Finance" with includeMasterPages on the new pages, verify, word check → save → close {save:"no"}.

Stop on: missing/unconfirmed colour, style or master, theme error or failed check, keepSide refusal, rolled-back running head or opener title (ask me), contact mismatch or single-frame overset rollback, continue_story blocker, chapter-number conflict (ask me).

Report: paths; style id map; theme results; new-page table; parity; open decisions (colour, chapter number, TOC, short running head, moved illustration, no new artwork, dropped schemes/labels, combined phones, dropped labels/sections); overset/placeholder before and after; missing text; undos; save/close.
```

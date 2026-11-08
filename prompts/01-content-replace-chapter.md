# Prompt 1: Chapter N-এর content replace (page by page, backup + per-page verification)

**Skill:** `.claude/skills/content-replace.md` (reference: `.claude/skills/brac-referral-template.md`)
**নিচের `{…}` অংশগুলো পূরণ করে পুরো block টা paste করুন।** উদাহরণে real v06 মান দেওয়া আছে।

| Placeholder | মানে | উদাহরণ (v06 job A) |
|-------------|------|---------------------|
| `{N}` | Chapter number | `1` |
| `{CHAPTER_NAME}` | Template-এর chapter নাম | `Access to Finance` |
| `{MASTER}` | Content page-এর master | `1-Access to Finance` |
| `{SOURCE}` | নতুন content (DOCX/TXT) | `I:\Indesign\content\v06_docx\Chapter 06 - Access to Financial Services (2)_Phone Numbers Checked.docx` |
| `{RUN_LABEL}` | Run copy-র নাম | `ch1-replace-2026-11-07` |
| `{URL_POLICY}` | Contact line-এ `https://` বা `Head Office:` থাকলে কী হবে | `stop-and-ask` অথবা `drop-with-note` |

---

## বাংলা prompt (paste করুন)

```text
Skill: .claude/skills/content-replace.md follow করো (BRAC reference: .claude/skills/brac-referral-template.md)। Skill-এর কোনো step এই prompt-এর সাথে না মিললে এই prompt-ই চলবে। run_script দিয়ে text লেখা বা format_text দিয়ে bold/roman ঠিক করা নিষেধ। শুধু নিচের tool-গুলো ব্যবহার করো।

কাজ: Chapter {N} "{CHAPTER_NAME}"-এর content (master "{MASTER}"-এর page-গুলো) নতুন content দিয়ে replace করো, page by page। Source: {SOURCE}। Layout আর character formatting হুবহু রাখতে হবে।

SAFETY (ভাঙা যাবে না):
- C:\Users\Litoondev\Downloads-এর কিছু খুলবে না, পড়বে না, save করবে না। Source শুধু I:\Indesign\content\... থেকে পড়বে। ফাইল সেখানে না থাকলে থেমে আমাকে copy করতে বলবে।
- I:\Indesign\test_fixtures\BRAC_TEST_MASTER.indd কখনো খুলবে না বা save করবে না। PowerShell-এ Copy-Item দিয়ে এটা I:\Indesign\test_fixtures\runs\{RUN_LABEL}.indd-এ copy করো (ফাইলটা আগে থেকে থাকলে থামো) আর শুধু সেই copy-তে কাজ করো।
- প্রতিটা tool call-এ document_id = run copy-র full path।
- SAFETY refusal এলে থামো। INDESIGN_MCP_WRITE_ROOTS বদলাবে না।
- EXECUTION_TIMEOUT_STILL_RUNNING বা INDESIGN_BUSY এলে শুধু probe_indesign চালাও, যতক্ষণ না উত্তর দেয়। তারপর আমাকে জানিয়ে আগের state যাচাই করে এগোবে। একই call অন্ধভাবে আবার চালাবে না।

Content rules: hidden/overset text নয়; কোনো content বাদ নয়; gap বজায়; margin-এর বাইরে কিছু নয়; bold label colon পর্যন্ত + roman value; Service Name bold, chapter color-এ; Contact info = anchored icon + tab + text প্রতি line-এ; icon/anchored object/tab/line break রাখো; overflow পরের page-এ cascade (overlap কখনো নয়)। Template structure-এ না মিললে guess নয়, mismatch note লিখবে।

ধাপগুলো এই ক্রমে:
0. probe_indesign → list_open_documents। run copy-র নামে আগে থেকে কিছু খোলা থাকলে থামো।
1. Copy-Item দিয়ে run copy বানাও → open_document {filePath: run copy}।
2. Fixture যাচাই: get_active_document, list_pages, list_master_spreads। আশা: 25 pages, 6x9in (432x648pt), master "{MASTER}" আছে। Chapter opener-এর master "A-Parent"; Chapter 1-এর জন্য opener হলো page XIII (index 12), content page "02".."12" (index 13..23), আর page "13" (index 24) "B-Blank"। এর কোনোটা না মিললে থেমে report করো।
3. backup_document {label: "before-ch{N}-replace"}। backupPath লিখে রাখো। Fail করলে থামো।
4. parse_content_file {filePath: {SOURCE}}। paragraphCount আর warnings দেখাও।
5. Baseline: check_overset_text (আগে থেকে থাকা overset, যেমন Agrani branch table বা Foreword story 35473, "pre-existing" হিসেবে লিখে রাখো)। তারপর chapter-এর সব page-এর জন্য verify_page_invariants {pageIndexes} (প্রতি call-এ max 16)। এই data-ই baseline।
6. Content map: snapshot_document দিয়ে (pageRange 1-based = index+1, প্রতি call-এ max 4 page) প্রতিটা provider entry-র paragraph চিনে নাও: Part Heading, Provider Name, Regular description, Paragraph Heading, Service Name Numbered (label/value), "Body Description Colon Bullets " (নামের শেষে space আছে), Body Description Numbers, Contact info (U+FFFC + tab)। Style lookup-এ doc.allParagraphStyles ব্যবহার হয়, কারণ style-গুলো group-এ থাকে। Source paragraph → template slot-এর একটা table বানিয়ে আমাকে দেখাও: কোন page, storyId, storyParagraphIndex, edit kind (replace / label-value / insertAfter / delete)। নিচের সব mismatch এই table-এ আলাদা লিখবে। আমার OK না পাওয়া পর্যন্ত কিছু লিখবে না।
   - Source-এর কোনো section template-এ নেই (যেমন "Government Services" group heading) → mismatch note, নিজে থেকে নতুন structure বানাবে না।
   - Template-এ এমন section আছে যা source-এ নেই (যেমন Agrani-র Documents বা Various Information, branch table) → delete করার প্রস্তাব mismatch note-এ দাও। Branch table DOCX-এ না থাকলে table যেমন আছে তেমন রাখো।
   - এক লাইনে ২টা বা তার বেশি ':' আছে (যেমন "Helpline: Phone: 0222…") → GREP শেষ colon পর্যন্ত bold করবে। আগেই mismatch হিসেবে দেখাও আর split করার প্রস্তাব দাও।
   - Contact line-এ "https://" বা "Head Office:" আছে → {URL_POLICY}। stop-and-ask হলে আমাকে জিজ্ঞেস করো। drop-with-note হলে scheme/label বাদ দিয়ে লেখো আর mismatch note রাখো।
7. প্রতিটা page-এর জন্য (page "02" দিয়ে শুরু, ক্রমানুসারে; একটা entry দুই page জুড়ে থাকলে একসাথে):
   a. snapshot_document সেই page(গুলো)র (story একই থাকলে storyId একই)।
   b. Contact block আগে: replace_contact_block {frameId বা firstParagraphIndex, lines, dryRun: true} → তারপর আসল call। dryRun line wrap বা overset মাপে না (result-এর notChecked), তাই আসল call-ও rollback হতে পারে। Default wrapPolicy "mismatch"। Wrap mismatch এলে একবার wrapPolicy "hangingIndent" দিয়ে চেষ্টা করো। Source-এ fax আছে কিন্তু template-এ fax icon নেই → typeAliases {fax: "phone"} বা extraIcons (iconFrom: সেই block-এর phone icon-এর storyId + characterIndex), mismatch note সহ। একই type-এর দ্বিতীয় line (যেমন দুটো phone number) extraIcons দিয়ে যোগ হয় না: এক line-এ লেখো ("+880... (Helpline); +880...") আর mismatch note রাখো। কখনো icon ছাড়া line লিখবে না। Line সংখ্যা বদলালে আবার snapshot নাও।
   c. replace_paragraphs {storyId, edits, dryRun: true}। mismatches বা overrideErrors থাকলে সেই paragraph-এ জোর করবে না। Note নিয়ে বাকিগুলো চালাও।
   d. replace_paragraphs আসল call (dryRun ছাড়া)। Paragraph শেষে delete করার আগে expectText দেবে। Inline table delete শুধু allowTable: true + expectTableRows/expectTableColumns দিয়ে, আর সেটা map-এ আমার অনুমোদন থাকলে। Insert-এর পরে "spaceBefore" warning এলে সেই edit-এ resetNextSpacing: true দিয়ে আবার চালাও।
   e. Overset rollback (দুই tool-এই default): কোনো write নতুন hidden text তৈরি করলে tool নিজেই undo করে: applied: false, rolledBack: true, mismatch reason "pushed into overset" (frameId, singleUnthreadedFrame সহ)। আবার undo করবে না। Mismatch note লেখো আর এই entry-তে থামো, আমাকে জানাও। Single frame (singleUnthreadedFrame: true) হলে কখনো allowOverset দেবে না। Threaded body story ইচ্ছাকৃতভাবে পরের page-এ যাবে এমন হলে ধাপ 8।
   f. ':' GUARD: tool নিজেই ২+ colon-যুক্ত বা template-এ colon নেই এমন line-এ ':' থাকা text লেখে না (mismatch, multiColon)। acceptGrepEffects দেবে না; {URL_POLICY} অনুযায়ী চলো।
   g. verify_page_invariants {pageIndexes: [এই page], baseline}। baselineDiff.problems খালি হতে হবে। emptyFrameOverlaps (যেমন page 02-এর empty frame 5887) ঠিক আছে; ওই frame delete বা move করবে না।
   h. snapshot_document দিয়ে bold check: প্রতিটা label-value paragraph-এ bold run ঠিক প্রথম ':' পর্যন্ত, value roman; Service Name bold আর chapter color-এ। না মিললে undo করে report করো।
   i. export_jpeg {pageIndices: [index], resolution: 100, outputPath: "I:\Indesign\test_output\runs\{RUN_LABEL}\"}। ছবিটা খুলে নিজে দেখো: overlap, margin, icon, Lorem।
8. Body story overflow: যে replace_paragraphs / replace_contact_block write threaded story-কে শেষ frame পেরিয়ে নিয়ে যায়, সেটা allowOverset: true দিয়ে চালাও, তারপর সঙ্গে সঙ্গে continue_story {storyId} (এটা font ছোট করে না, item সরায় না; একই master-এ page যোগ করে frame thread করে)। তারপর check_overset_text-এ সেই story আর overset থাকবে না। জানা সমস্যা: নতুন frame margin-এর top-এ (43.2pt) বসে, template body frame-এর চেয়ে ~13pt উপরে; snapshot দিয়ে একই side-এর template page-এর body frame top দেখো, resize_text_frame দিয়ে top মিলাও (left/right/bottom একই), আবার overset আর verify যাচাই করো। কখনো fit_text_to_frame allowShrink, reflow_page_layout বা font/leading/tracking বদলাবে না। continue_story-এর data.blocker এলে (table row frame-এর চেয়ে লম্বা, keep options ইত্যাদি) allowOverset write-টা undo করো (expectUndoName সেই tool-এর নাম) আর থেমে blocker দেখাও। "starts another section" error এলে থামো। allowCrossSection: true শুধু আমার অনুমতিতে। Odd সংখ্যক page যোগ হলে parity warning দেখাও আর একটা B-Blank page যোগ করার প্রস্তাব দাও (নিজে যোগ করবে না)।
9. শেষ যাচাই: check_overset_text (baseline-এর চেয়ে নতুন overset story = 0); find_text {findWhat: "Lorem", includeMasterPages: true} আর "ipsum" (chapter page-এ 0 হতে হবে); chapter-এর সব page-এ verify_page_invariants with baseline। Word check: source-এর প্রতিটা paragraph-এর text story-তে আছে কিনা মিলিয়ে দেখো, আর যা নেই তার list দাও (mismatch note-এ থাকা জিনিস আলাদা করে)।
10. save_document (in place, শুধু run copy) → close_document {save: "no"} → list_open_documents খালি কিনা দেখো।

থামো এবং report করো (guess করবে না), যদি:
- Fixture facts না মেলে, backup fail করে, বা source Downloads-এ থাকে।
- কোনো call-এ overrideErrors, rollbackRequired, rolledBack: true, বা anchored-object count বদলায়।
- Contact line-এর সংখ্যা বা type-এর ক্রম template-এর সাথে না মেলে (mismatch {templateTypes, sourceTypes})।
- ধাপ 7e-র overset rollback আসে।
- continue_story blocker দেয় বা section পার হতে চায়।
- একই page দুইবার চেষ্টার পরও verify-এ problems থাকে।
- Timeout বা SAFETY refusal আসে।

Final report-এ থাকবে:
1. Run copy path, backupPath, source file, মোট সময়।
2. Page-by-page table: page name/index | entry (provider) | applied edits সংখ্যা | mismatches | verify ok / baselineDiff.problems | JPEG path।
3. সব mismatch note-এর list (কী বাদ গেল, কেন, আমার কী সিদ্ধান্ত লাগবে)।
4. Overset: আগে vs পরে (pre-existing আলাদা করে); placeholder count; source word check-এ missing list।
5. continue_story-তে যোগ হওয়া page (name, side), parity warning।
6. কোন undo চালানো হয়েছে, কেন।
7. Run copy save হয়েছে কিনা, সব document বন্ধ কিনা।
```

---

## English version (short)

```text
Follow skill .claude/skills/content-replace.md (BRAC reference: brac-referral-template.md). Where the skill disagrees with this prompt, this prompt wins. Do not write text with run_script or fix bold/roman with format_text.

Task: replace the content of Chapter {N} "{CHAPTER_NAME}" (pages on master "{MASTER}") page by page from {SOURCE}, keeping the layout and character formatting exactly.

Safety: never touch C:\Users\Litoondev\Downloads. Never open or save BRAC_TEST_MASTER.indd; Copy-Item it to I:\Indesign\test_fixtures\runs\{RUN_LABEL}.indd and work only on the copy, passing document_id = its full path on every call. A SAFETY refusal means stop. On a timeout or INDESIGN_BUSY, only call probe_indesign until it answers.

Steps: probe_indesign, list_open_documents → copy, open_document → check the fixture (25 pages, 6x9, opener XIII = index 12, content "02".."12" = 13..23, "13" = B-Blank) → backup_document {label:"before-ch{N}-replace"} → parse_content_file → baseline check_overset_text + verify_page_invariants → snapshot_document (1-based, at most 4 pages per call) to build a source→slot map. Show me the map and wait for my OK. Then, per page: replace_contact_block dryRun (it does not measure wraps/overset), then the real call (on a wrap mismatch, retry once with hangingIndent; fax via typeAliases {fax:"phone"} or extraIcons; a second number of a type the block already has goes on the same line, e.g. "+880... (Helpline); +880...", with a note) → replace_paragraphs dryRun, then the real call → verify_page_invariants with the baseline → bold check with snapshot → export_jpeg at 100 dpi to test_output\runs\{RUN_LABEL}\ and look at it. Intended overflow of a threaded body story: pass allowOverset:true on that write and call continue_story {storyId} straight after (it never shrinks fonts or moves items); then align the added frame's top with the template body frame (it starts ~13pt high at the margin) using resize_text_frame and recheck overset. Never shrink fonts and never use reflow_page_layout. Finally check_overset_text, find_text {findWhat} Lorem/ipsum, verify all pages, run a source word check, save_document in place, close_document {save:"no"}.

Guards: both write tools undo a write that creates new hidden text by themselves (applied:false, rolledBack:true, mismatch 'pushed into overset' with frameId/singleUnthreadedFrame): do not undo again; record the mismatch and stop on that entry. Never use allowOverset on a single unthreaded frame. Text with 2+ ':' (or ':' where the template line has none) is refused under the Contact info / Colon Bullets GREP: do not pass acceptGrepEffects; split it, or follow {URL_POLICY} for URLs and "Head Office:".

Stop and report instead of guessing on: fixture mismatch, backup failure, overrideErrors/rollback (including an overset rollback), contact type or count mismatch, a continue_story blocker or section crossing, a page still failing after 2 tries, timeout, SAFETY.

Report: run copy and backup paths; per-page table (edits, mismatches, verify result, JPEG); all mismatch notes; overset before and after; placeholder count; missing source text; pages added and parity; undos run; saved and closed status.
```

# Prompt 5: Document-এর দ্রুত health check (read-only)

**Skill:** `.claude/skills/brac-referral-template.md` §8 (expected findings) + `.claude/skills/content-replace.md` step 7 (finish checks), memory-তে থাকা Content Placement Rules সহ

| Placeholder | মানে | উদাহরণ |
|-------------|------|--------|
| `{FILE}` | যে document check করতে হবে | `I:\Indesign\test_fixtures\runs\ch1-replace-2026-11-07.indd` |
| `{PAGES}` | কোন page (খালি = সব) | `all` অথবা `02-12` |

---

## বাংলা prompt (paste করুন)

```text
Skill: .claude/skills/brac-referral-template.md (§8 expected findings) আর .claude/skills/content-replace.md-এর step 7 (finish checks) follow করো।

কাজ: {FILE}-এর দ্রুত health check, page {PAGES}। এটা শুধু READ-ONLY: কোনো কিছু বদলাবে না, ঠিক করবে না, save করবে না। undo, relink, delete, update_all_links, replace, fit বা reflow কিছুই চলবে না।

SAFETY:
- {FILE} I:\Indesign\test_fixtures\runs বা I:\Indesign\test_output-এর ভেতরে না হলে থামো। আসল book check করতে চাইলে আমাকে বলো সেটা run folder-এ copy করতে। BRAC_TEST_MASTER.indd বা Downloads-এর কিছু খুলবে না।
- Timeout এলে শুধু probe_indesign। প্রতিটা call-এ document_id = {FILE}।

ধাপগুলো এই ক্রমে:
0. probe_indesign → list_open_documents। খোলা না থাকলে open_document {filePath: {FILE}} (আমি খুলিনি, তাই শেষে বন্ধ করবে)।
1. get_active_document, list_pages, list_master_spreads। Page count, size (6x9in = 432x648pt), প্রতিটা page-এর master আর side-এর table বানাও। Chapter opener (Chapter Number/Name frame থাকা page) right side-এ আছে কিনা দেখো।
2. Overset: check_overset_text। প্রতিটা story: storyId, frame, page, master-এ কিনা।
3. Placeholder: find_text {findWhat: "Lorem", includeMasterPages: true} আর {findWhat: "ipsum", includeMasterPages: true}। Page সহ list দাও (জানা pre-existing: page V-এর Foreword-এ Lorem)।
4. Page rules: verify_page_invariants {pageIndexes} প্রতি call-এ max 16 page (25 page হলে 0–15 আর 16–24)। এখান থেকে margin violation (margin box-এর বাইরে item), text frame overlap (emptyFrameOverlaps আলাদা করে, যেমন page 02-এর frame 5887 স্বাভাবিক), overset, placeholder, masterIssues (running head overset বা placeholder) আর অস্বাভাবিক gap নাও।
5. Missing icon: chapter content page-গুলোতে snapshot_document (pageRange 1-based, প্রতি call-এ max 4 page)। "Contact info" style-এর প্রতিটা paragraph-এ anchoredCount ≥ 1 আর text "U+FFFC + tab" দিয়ে শুরু হতে হবে। না হলে "missing icon" (page, storyId, storyParagraphIndex, text-এর শুরু)। Icon-এর রঙ chapter color না হলে (যেমন Agrani-র Pantone 2593 C) আলাদা করে লেখো।
6. Formatting spot-check (একই snapshot থেকে): label-value paragraph-এ bold run প্রথম ':' পর্যন্ত কিনা (দুই colon-এর line-এ শেষ colon পর্যন্ত bold হলে flag); Service Name Numbered bold আর chapter color-এ কিনা।
7. Links আর fonts: list_images (LINK_MISSING list; cover EPS আর page V/VII-এর 2টা PNG জানা, "expected" লিখবে); get_document_fonts (missing বা substituted font, বিশেষ করে Helvetica Neue LT Pro)।
8. যদি আমি খুলিনি এমন document খুলে থাকো: close_document {save: "no"} → list_open_documents।

থামো এবং report করো, যদি: {FILE} write roots-এর বাইরে হয়; document খুলতে timeout হয়; কোনো tool SAFETY বা অপ্রত্যাশিত error দেয় (error, code, data হুবহু দেখাও)।

Final report-এ থাকবে (একটা summary line + table):
1. Summary: OK / সমস্যা আছে। মোট overset, placeholder, missing icon, margin violation, overlap, missing link (expected বাদে), missing font।
2. Page-wise table: page name | index | side | master | overset | placeholder | margin | overlap | missing icon | note।
3. প্রতিটা finding-এর জন্য id (storyId/frameId), আর কোন prompt দিয়ে ঠিক করা যায় (overflow → Prompt 3, ভুল content → Prompt 1, ইত্যাদি)।
4. Pre-existing বা expected finding আলাদা করে (3টা missing link, Foreword Lorem, empty frame 5887, Agrani branch table overset)।
5. নিশ্চিত করো যে document-এ কিছু বদলায়নি আর যা খুলেছিলে তা বন্ধ হয়েছে।
```

---

## English version (short)

```text
Follow brac-referral-template.md §8 (expected findings) and the finish checks in content-replace.md step 7.

Task: a READ-ONLY health check of {FILE}, pages {PAGES}. Change nothing (no undo, relink, delete, replace, fit or reflow) and never save. {FILE} must be under test_fixtures\runs or test_output; never open the master or anything in Downloads. document_id = {FILE}.

Steps: probe_indesign, list_open_documents, open_document if needed → get_active_document, list_pages, list_master_spreads (size, masters, sides; openers on right pages) → check_overset_text → find_text "Lorem"/"ipsum" with includeMasterPages → verify_page_invariants in chunks of at most 16 pages (margins, overlaps with emptyFrameOverlaps kept separate, overset, placeholder, masterIssues, gaps) → snapshot_document over the chapter pages (1-based, at most 4 pages per call): every "Contact info" paragraph needs anchoredCount ≥1 and must start with U+FFFC+tab, plus bold-to-first-colon and Service Name colour spot checks → list_images (the 3 known LINK_MISSING are expected) → get_document_fonts → close what you opened {save:"no"}.

Report: a summary line with counts; a per-page table (overset, placeholder, margin, overlap, missing icon); ids for each finding and which prompt fixes it; pre-existing/expected findings listed separately; confirmation that nothing changed and that documents are closed.
```

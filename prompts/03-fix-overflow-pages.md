# Prompt 3: Page A–B-এর overflow/overset ঠিক করা, design না বদলে

**Skill:** `.claude/skills/brac-referral-template.md` (overset/reflow নিয়ম) + `.claude/skills/content-replace.md` step 6.5–6.7 আর 7 (verify, cascade)

| Placeholder | মানে | উদাহরণ |
|-------------|------|--------|
| `{RUN_FILE}` | যে run copy ঠিক করতে হবে (write roots-এর ভেতরে থাকতে হবে) | `I:\Indesign\test_fixtures\runs\ch1-replace-2026-11-07.indd` |
| `{PAGE_A}` / `{PAGE_B}` | Page name (InDesign-এ যা দেখায়) | `02` / `06` |

---

## বাংলা prompt (paste করুন)

```text
Skill: .claude/skills/brac-referral-template.md (overset/cascade নিয়ম) আর .claude/skills/content-replace.md-এর verify step follow করো। এই prompt-এর সাথে মতভেদ হলে এই prompt চলবে।

কাজ: {RUN_FILE}-এ page "{PAGE_A}" থেকে "{PAGE_B}"-এর overflow/overset text ঠিক করো। Design বদলাবে না: font size, leading, tracking, style, color, frame-এর অবস্থান, gap আর master আগের মতো থাকবে। কোনো text লুকানো বা বাদ দেওয়া যাবে না।

SAFETY:
- {RUN_FILE} অবশ্যই I:\Indesign\test_fixtures\runs বা I:\Indesign\test_output-এর ভেতরে থাকতে হবে। না থাকলে থামো। BRAC_TEST_MASTER.indd বা Downloads-এর কিছু খুলবে না।
- প্রতিটা call-এ document_id = {RUN_FILE}। SAFETY refusal এলে থামো। Timeout এলে শুধু probe_indesign।

অনুমোদিত fix (শুধু এই ক্রমে):
  (১) Threaded body story: continue_story {storyId}। এটা story-র শেষ frame-এর page-এর পরে একই master-এ page যোগ করে আর frame thread করে; font ছোট করে না, item সরায় না। এটাই মূল উপায়। (cascade_reflow এর পুরনো alias; continue_story-ই ডাকো।)
      জানা সমস্যা: নতুন frame margin-এর top-এ (43.2pt) বসে, template body frame-এর চেয়ে ~13pt উপরে। snapshot_document দিয়ে একই side-এর template page-এর body frame top দেখো, তারপর resize_text_frame দিয়ে শুধু সেই নতুন frame-এর top মিলাও (left/right/bottom একই)। এরপর check_overset_text; আবার overflow হলে continue_story আবার চালাও।
  (২) Unthreaded একক frame (যেমন ছোট box), যার নিচে খালি জায়গা আছে: fit_text_to_frame {frameId, method: "expandFrame"}। এটা নিচের margin বা নিচের item পর্যন্ত বাড়ায়। growth pt-এ report করো।
নিষেধ: fit_text_to_frame-এ allowShrink বা shrinkFont; reflow_page_layout (এটা অন্য item সরায়); resize_text_frame (উপরের নতুন frame-এর top মেলানো ছাড়া) বা transform_item; format_text, set_paragraph_formatting, apply_style; text মুছে জায়গা করা; overset text-কে অন্য frame-এ copy করা।

ধাপগুলো এই ক্রমে:
0. probe_indesign → list_open_documents। {RUN_FILE} খোলা না থাকলে open_document।
1. backup_document {label: "before-overflow-fix-{PAGE_A}-{PAGE_B}"}।
2. list_pages: page name থেকে 0-based index বের করো। একই নামের একাধিক page থাকলে থামো আর জিজ্ঞেস করো (front matter-এ রোমান আর chapter-এ সংখ্যা আছে)।
3. Baseline: check_overset_text (পুরো document); verify_page_invariants {pageIndexes: A..B} (max 16, বেশি হলে ভাগ করে)। এটা baseline হিসেবে রাখো। export_jpeg {pageIndices: A..B, outputPath: "I:\Indesign\test_output\runs\overflow-fix\before\"}।
4. প্রতিটা overset story যার শেষ frame A–B-এর মধ্যে: snapshot_document দিয়ে frame threaded কিনা, master/opener frame কিনা, table বা anchored আছে কিনা দেখো। তারপর উপরের (১) বা (২) বেছে নাও। Story-র শেষ frame A–B-এর বাইরে হলে ছোঁবে না, শুধু report করবে।
5. continue_story-এর result:
   - data.blocker এলে (table row frame-এর চেয়ে লম্বা, keepWithNext/keep options, বড় anchored object) থামো। blocker.reasons, oversetCells, trailingParagraphs দেখাও। allowRowBreak: true শুধু আমার অনুমতিতে।
   - "starts another section" error এলে থামো। allowCrossSection শুধু আমার অনুমতিতে।
   - Odd সংখ্যক page যোগ হলে parity warning দেখাও। পরের chapter opener left page-এ গেলে থামো আর chapter-এর শেষে একটা B-Blank page (add_page {at: "after", referencePageIndex, masterName: "B-Blank"}) যোগ করার প্রস্তাব দাও।
6. fit_text_to_frame-এর result-এ didFit: false বা mismatch এলে কিছু বদলায়নি। Report করো, এখানে continue_story চালাবে না, কারণ একক frame-এর জন্য নতুন page লাগানো design পরিবর্তন।
7. প্রতিটা fix-এর পরে: verify_page_invariants {pageIndexes: A..B + নতুন page, baseline}। baselineDiff.problems খালি হতে হবে (নতুন page যোগ হওয়া আর anchor-এর page বদল ছাড়া)। margin, overlap বা gap delta > 6pt থাকলে undo করো আর থামো।
8. শেষ: check_overset_text (A–B-এর story-গুলো আর overset নয়; অন্য overset আগের মতো); find_text {findWhat: "Lorem"} (নতুন page-এ 0); export_jpeg after (I:\Indesign\test_output\runs\overflow-fix\after\) আর ছবি দেখে overlap/margin যাচাই।
9. save_document (in place) → close_document {save: "no"} (আমি না বললে আমার খোলা document-ও বন্ধ করো) → list_open_documents।

থামো এবং report করো, যদি: page name দ্ব্যর্থক হয়; overset story master page (running head) বা opener title-এ থাকে (সেটা text বা layout-এর সিদ্ধান্ত, master-template skill দেখো); continue_story blocker বা section crossing আসে; parity ভাঙে; verify-এ নতুন problem আসে; একটা fix দুইবারের পর কাজ না করে।

Final report-এ থাকবে:
1. backupPath; ঠিক করার আগের overset story-র list (storyId, শেষ frame, page, character count)।
2. প্রতিটা story-তে কী করা হয়েছে: continue_story (যোগ হওয়া page-এর name/side) / expandFrame (growth pt) / কিছুই না (কারণ)।
3. Blocker বা mismatch-এর বিস্তারিত, আর আমার কী সিদ্ধান্ত লাগবে।
4. Parity আর পরের chapter opener-এর side।
5. verify before vs after, before/after JPEG path।
6. পরে কোনো overset বাকি থাকলে তার list (pre-existing আলাদা করে)। Save আর close status।
```

---

## English version (short)

```text
Follow brac-referral-template.md (overset/cascade rules) and the verify step of content-replace.md; this prompt wins.

Task: fix overset text on pages "{PAGE_A}".."{PAGE_B}" of {RUN_FILE} without changing the design (no font/leading/tracking/style/colour/position/gap/master changes, no hidden or deleted text). {RUN_FILE} must be under test_fixtures\runs or test_output, otherwise stop. document_id = {RUN_FILE} on every call.

Allowed fixes, in order: (1) continue_story {storyId} for threaded body stories (never shrinks fonts or moves items; cascade_reflow is only its deprecated alias). Known issue: the added frame sits at the top margin (43.2pt), ~13pt above the template body frame; align only that new frame's top to the template body frame of a same-side page with resize_text_frame, then recheck overset (run continue_story again if needed). (2) fit_text_to_frame {method:"expandFrame"} for an unthreaded frame with free space below it. Forbidden: allowShrink/shrinkFont, reflow_page_layout, any other resize/transform, any formatting or style tool, deleting text.

Steps: probe/open → backup_document → list_pages (stop on duplicate names) → baseline check_overset_text + verify_page_invariants + before JPEGs → per overset story whose last frame is on A-B: snapshot, then (1) or (2). On a blocker, a section crossing or broken parity: stop and show the details (propose one B-Blank page via add_page {at:"after", referencePageIndex, masterName:"B-Blank"} for parity). When expandFrame does not fit, report it and do not add pages. After each fix, verify_page_invariants with the baseline; on new problems, undo and stop → final check_overset_text, find_text Lorem, after JPEGs → save → close {save:"no"}.

Report: backupPath; overset list before; action per story (pages added / growth / none + reason); blockers and the decisions needed; parity; verify and JPEGs before and after; anything still overset (pre-existing separated); save/close status.
```

# BRAC Referral Directory: ready-to-paste prompts

এই ফোল্ডারে ৫টা prompt আছে। প্রতিটা আলাদা `.md` ফাইলে রাখা, যাতে সরাসরি Claude Code-এ (InDesign MCP server চালু অবস্থায়) paste করা যায়। প্রতিটা prompt-এ লেখা আছে কোন skill follow করতে হবে, কোন tool কোন ক্রমে চলবে, কোথায় থেমে report করতে হবে (guess না করে), আর final report-এ কী কী থাকবে। ফাইলের উপরে বাংলা version (technical term ইংরেজিতে) আর নিচে ছোট English version।

| # | ফাইল | কাজ | InDesign-এ পরিবর্তন করে? |
|---|------|-----|------------------------|
| 1 | [01-content-replace-chapter.md](01-content-replace-chapter.md) | Chapter N-এর content DOCX/TXT থেকে page by page replace করা, backup আর প্রতি page verify সহ | হ্যাঁ (শুধু run copy-তে) |
| 2 | [02-new-chapter-from-template.md](02-new-chapter-from-template.md) | Chapter 1 template থেকে নতুন Chapter N বানানো: color X, content file Y | হ্যাঁ (শুধু run copy-তে) |
| 3 | [03-fix-overflow-pages.md](03-fix-overflow-pages.md) | Page A–B-এর overflow/overset ঠিক করা, design না বদলে | হ্যাঁ (শুধু run copy-তে) |
| 4 | [04-restore-latest-backup.md](04-restore-latest-backup.md) | সর্বশেষ backup থেকে run copy restore করা | হ্যাঁ (run copy overwrite করে) |
| 5 | [05-health-check.md](05-health-check.md) | দ্রুত health check: overset, placeholder text, missing icon, margin violation | না (read-only) |

## ব্যবহারের আগে (একবার)

1. `I:\Indesign`-এ `npm run build` চালান, তারপর MCP server restart করুন (Claude Code restart করলে হয়)। নাহলে `dist/` পুরনো থাকবে আর নতুন tool (`replace_paragraphs`, `replace_contact_block`, `verify_page_invariants`, `continue_story`, `theme_chapter`, `restore_backup` ইত্যাদি) পাওয়া যাবে না।
2. Source content ফাইল `I:\Indesign\content\v06_docx\`-এ **copy করা** থাকতে হবে। আসল ফাইলগুলো আছে `C:\Users\Litoondev\Downloads\Brac`-এ। Claude কখনো Downloads থেকে পড়বে না, খুলবে না, save করবে না। নতুন ফাইল লাগলে আপনি নিজে copy করে দিন।
3. Template book: `I:\Indesign\test_fixtures\BRAC_TEST_MASTER.indd`। এটা আপনার "BRAC Referral Directory Book 06.indd"-এর copy (v06, 25 pages, 6x9in, 0.6in margins, facing pages)। Master নিজে কখনো খোলা হয় না। প্রতিবার এটা থেকে একটা run copy বানানো হয়: `I:\Indesign\test_fixtures\runs\<label>.indd`। v05 (`BRAC_TEST_V05.indd`) আর ব্যবহার করা হবে না।
4. Server শুধু এই দুই ফোল্ডারে লেখে: `I:\Indesign\test_fixtures\runs` আর `I:\Indesign\test_output` (default write roots)। কাজ শেষে run copy যাচাই করে আসল book-এ নিজে কপি করুন। Claude-কে `INDESIGN_MCP_WRITE_ROOTS` বদলাতে বলবেন না।

## সব prompt-এ একই নিয়ম

- Content rules: hidden/overset text চলবে না; কোনো content বাদ পড়বে না; gap বজায় থাকবে; margin-এর বাইরে কিছু যাবে না; bold/roman pattern হুবহু থাকবে (bold label colon পর্যন্ত, তারপর roman value; Service Name bold, chapter color-এ); icon, anchored object, tab আর line break থাকবে; overflow পরের page-এ cascade হবে (overlap কখনো না); template-এ না মিললে guess না করে **mismatch note**।
- Timeout হলে (`EXECUTION_TIMEOUT_STILL_RUNNING` / `INDESIGN_BUSY`) শুধু `probe_indesign` চালাতে হবে, যতক্ষণ না InDesign উত্তর দেয়। একই call অন্ধভাবে আবার চালানো যাবে না। InDesign kill করা যাবে না।
- `SAFETY` refusal মানে থামা। Path ঘুরিয়ে বা write roots বাড়িয়ে refusal এড়ানো যাবে না।
- কাজ শেষে নিজের খোলা সব document `close_document` (save: "no", বা prompt অনুযায়ী) দিয়ে বন্ধ করতে হবে। শেষে `list_open_documents` দিয়ে নিশ্চিত হতে হবে।

## Tool-এর বর্তমান আচরণ (round 5, 2026-11-07: harness 34/34 pass)

| Tool | আচরণ | Prompt-এ কী করতে হয় |
|------|------|----------------------|
| `replace_paragraphs`, `replace_contact_block` | নতুন hidden/overset text তৈরি করে এমন write tool নিজেই undo করে: `applied:false`, `rolledBack:true`, mismatch `pushed into overset` (frameId, singleUnthreadedFrame) | আবার undo নয়; mismatch note। ইচ্ছাকৃত overflow হলে write-এ `allowOverset:true`, তারপর সঙ্গে সঙ্গে `continue_story` |
| `replace_contact_block` | `wrapPolicy` `mismatch` (default) / `hangingIndent` / `warn`। overset হলে সব policy-তে rollback। dryRun wrap মাপে না (`notChecked`)। `extraIcons` একই type-এর দ্বিতীয় line যোগ করে না | wrap হলে একবার `hangingIndent`; দুটো phone number এক line-এ ("... (Helpline); ...") + note |
| GREP `.+(?<=:)` (Contact info, Colon Bullets) | শেষ colon পর্যন্ত bold করে, তাই ২+ colon বা template-এ নেই এমন ':' থাকা text tool লেখে না (`acceptGrepEffects:true` ছাড়া) | `https://` / `Head Office:` বাদ দিয়ে note (আপনার নিশ্চিত করার জন্য) |
| `theme_chapter` | Duplicate style-এর shading/border আর chapter color-এর tint নিজেই বদলায়। Running head overset হলে textReplace rollback (`textReplaceOverset` mismatch) | ছোট running head `replace_paragraphs` দিয়ে master story-তে + note। rule/underline color-এর styleColours warning জানা noise |
| Opener title (`replace_paragraphs`) | Frame-এ না ধরলে refuse (rollback); দরকারি height বলে না | আপনার অনুমতিতে `transform_item` দিয়ে illustration উপরে + `resize_text_frame` দিয়ে title frame বড়, এক লাইন করে |
| `continue_story` (`cascade_reflow` = পুরনো alias) | font ছোট করে না, item সরায় না; নতুন page + frame thread করে। জানা সমস্যা: নতুন frame margin-এর top-এ, template body frame-এর চেয়ে ~13pt উপরে | `resize_text_frame` দিয়ে top মিলানো; chapter-এর page বিজোড় হলে একটা `B-Blank` page |
| API বানান | `add_page {at:'after', referencePageIndex}`, `duplicate_page {toLocation:'afterPage', referencePageIndex, keepSide}`, `find_text {findWhat}` | |

## আপনার সিদ্ধান্ত বাকি (Claude নিজে ঠিক করবে না)

- Chapter 2–7-এর color (Ch1 = `Pantone 7498 C`; `Pantone 3298 C` শুধু test-এ ব্যবহার হয়েছে)।
- Chapter numbering আর TOC (page IX) update: book-এ আগে থেকেই "Chapter 2 / Access to Social Welfare" opener আছে।
- Contact line থেকে URL scheme (`https://`) বা colon label (`Head Office:`) বাদ দেওয়া।
- দুটো phone number এক contact line-এ জোড়া দেওয়া।
- নতুন chapter-এর opener artwork নেই (এখনো Chapter 1-এর finance icon)।

These prompts are for the user's real BRAC v06 jobs. They work only on run copies, never on `BRAC_TEST_MASTER.indd` or anything in Downloads. Each prompt names its skill, the exact tool order, its stop conditions and the required final report.

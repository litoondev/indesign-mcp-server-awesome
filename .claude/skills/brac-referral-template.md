# Skill: BRAC Referral Directory Book (v06 template) — design DNA and facts

Read this before any BRAC job. The workflows are in `content-replace.md` (job A: replace a chapter's content) and `master-template.md` (job B: build a new chapter). Every fact below was verified on a copy of the user's `BRAC Referral Directory Book 06.indd` (v06, 3.4 MB). **v05 is the wrong book. Never use it.** Ids are valid on a fresh copy of the v06 master. After edits, re-read them with `snapshot_document` / `list_paragraph_styles`.

## 1. Files and safety
| What | Where |
|---|---|
| Pristine test master (never open, never save) | `I:\Indesign\test_fixtures\BRAC_TEST_MASTER.indd` (copy of v06) |
| Run copies (work only here) | `I:\Indesign\test_fixtures\runs\<label>.indd` |
| Backups / exports / notes | `I:\Indesign\test_output\...` |
| Source content (source of truth) | `I:\Indesign\content\v06_docx\Chapter 0N - ....docx` (copies; never read from Downloads) |
| Not source of truth | `content\ch*_content.txt`, `contact_details_all_chapters.txt` (old) |
| User's real book | under `C:\Users\Litoondev\Downloads\Brac` — **never open, copy, save or modify** |

Tools refuse writes outside `INDESIGN_MCP_WRITE_ROOTS` (default `test_fixtures\runs;test_output`) and anything under a Downloads folder. Do not widen the roots yourself; the user does that.

## 2. Document setup
- 25 pages, 6 x 9 in, facing pages, 0.6 in margins on all sides, Helvetica Neue LT Pro (55 Roman, 75 Bold, 65 Medium).
- Tools work in **points** (1 in = 72 pt; margin = 43.2 pt) with page-relative bounds.
- Page addressing differs by tool. Check this every time:
  - `snapshot_document.pageRange`: **1-based positions** (page "02" = `"14"`).
  - `verify_page_invariants.pageIndexes`, `export_jpeg.pageIndices`, `duplicate_page.pageIndex`, `apply_master.pageIndices`: **0-based indexes**.
  - `export_jpeg.pageRange`: page names, or `+N` for positions.

| Index | Name | Master | Content |
|---|---|---|---|
| 0-2 | 1, 2, 3 | none | cover (EPS, link missing), blank, title |
| 3-11 | IV-XII | A-Parent | front matter: IV credits, V foreword, VII introduction, **IX = TOC (static table)**, X-XI abbreviations |
| 12 | XIII | A-Parent | **Chapter 1 opener** |
| 13-23 | 02-12 | 1-Access to Finance | Chapter 1 content |
| 24 | 13 | B-Blank | existing "Chapter 2 / Access to Social Welfare & Protection Services" opener (rect 51998, frames 52029/52052). They overlap in the template already; that is not your bug |

Masters: `A-Parent`, `B-Blank`, `1-Access to Finance` (id 258), `2-Access to Social Welfare` (id 51234; no content pages use it yet).

## 3. Chapter 1 opener (page XIII, index 12)
- Rectangle 49496, full bleed, fill `Pantone 7498 C`.
- Frame **49996** (story 49978): `Chapter 1` (Chapter Number) `\r` `Access to Finance` (Chapter Name). It is a single frame with no thread: a longer title is refused by `replace_paragraphs` (rolled back, `singleUnthreadedFrame:true`). Fix: `master-template.md` Part A step 7.
- Frame **51009** (story 50991): description, style Regular White.
- Group 49948: white illustration, finance icon set specific to this chapter.
- Gaps to keep: heading-to-description and description-to-illustration as on the template (27.03 pt / 17.28 pt).

## 4. Chapter 1 content (pages 02-12)
- Story **5846** (PKB, then Agrani): frame 5864 on page 02, then frame 46588 on page 03, and so on.
  - It is **already overset at baseline**: the Agrani branch table (116 rows) has only 48 rows composed. That is pre-existing; your job must not add new hidden text.
  - Because the story already overflows, the automatic overset rollback only fires when an edited paragraph that was composed becomes overset. Compare `check_overset_text` / snapshots with the baseline yourself after each page.
- Page 02 also has empty frame **5887** (provider-name background area). Keep it. Overlaps with it appear under `emptyFrameOverlaps`; they are not failures.
- PKB entry, paragraphs 0-33 of story 5846:

```
0  Part Heading           A ∙ Safe Migration
1  Provider Name          Probashi Kallyan Bank (PKB)
2  Regular                description
3  Paragraph Heading      Service/s
4-5 Service Name Numbered Migration Loan without Collateral: ... / Other Services: ...
6  Paragraph Heading      Eligibility Criteria
7-10 Body Description Colon Bullets   Nationality: / Age: / Income Source: / Status:
11 Paragraph Heading      Documents Requirement
12-17 Body Description Numbers (12 restarts the list at 1)
18 Paragraph Heading      Various Relevant Information
19-23 Colon Bullets       Loan Limit: / Loan Term: / Repayment Schedule: / Interest Rate: / Service Delivery Time:
24 Paragraph Heading      Process to Get Service
25 ...                    steps
26 Paragraph Heading      Contact Information
27-30 Contact info        ￼\taddress / ￼\tweb / ￼\temail / ￼\tphone   (frame 46588)
31 Paragraph Heading      Probashi Kallyan Bank Branches
32-33                     inline tables (U+0016)
```

- Agrani contact block: paragraphs 65-67 (address/web/phone, frame 49888). Its table is at p69.
  - The Agrani icons are `Pantone 2593 C`, not the chapter colour. That is a pre-existing template fact; record it, do not "fix" it unasked.
- Reintegration entry: story 51733, frames 51730/51765 on pages 11-12.

## 5. Paragraph styles (style groups: always use `doc.allParagraphStyles` / group paths)
`doc.paragraphStyles` lists only 3 styles. Tools accept an id, a `Group/Name` path, or a unique name.

| Style (path) | id | Formatting DNA |
|---|---|---|
| `Regular set/Color Reset/Part Heading` | 46572 | 75 Bold 16 pt, **chapter colour**; paragraph border/rule in chapter colour |
| `Regular set/Color Reset/Provider Name` | 42373 | 55 Roman 12 pt, Paper, **paragraph shading in chapter colour** |
| `Regular set/Paragraph Heading` | 42296 | 75 Bold 12 pt, Pantone Neutral Black C |
| `Regular set/Regular` | 28407 | 55 Roman 10/12, Black |
| `Regular set/Color Reset/Service Name Numbered` | 51377 | **Bold label up to ':' in chapter colour**, roman value in Black |
| `Regular set/Body Description Colon Bullets ` (TRAILING SPACE) | 42932 | **Bold label up to ':'**, roman value, colour 800 |
| `Regular set/Body Description Numbers` | 52088 | numbered list, roman, 800 |
| `Regular set/Contact info` | 49556 | `￼` icon + `\t` + roman text per line; GREP `.+(?<=:)` -> Bold |
| `Regular set/Chapter Number` / `Regular set/Chapter Name` | 42124 / 52089 | opener title, 75 Bold, Paper |
| `Regular set/Regular White` | (look up) | opener description |
| `Regular set/See Page for Contacts` | (look up) | cross-reference |

Character style `Running head` (id 51932) is in Pantone 7498 C. It is used by the chapter master's running head (frame 48265: `Chapter 1: Access to Finance`).

**The GREP trap:** in Contact info, `.+(?<=:)` bolds **up to the LAST colon**.
- So `Head Office: ...`, `https://...` or `Helpline: Phone: 0222...` come out wrongly bold.
- `replace_contact_block` and `replace_paragraphs` refuse (mismatch, nothing written) a line with ':' where the template line has none, and any paragraph with 2+ ':' under this GREP (`multiColon` names the part that would be bold). Only `acceptGrepEffects:true` overrides that; do not use it to push wrong bolding through.
- Default practice: drop the label or scheme (`Head Office:`, `https://`) and record a mismatch note for the user to confirm.
- Colon Bullets also bold everything up to the last ':' in the line. Check every value for a second ':' before writing.

## 6. Colours
| Use | Swatch |
|---|---|
| Chapter 1 colour: opener rect, Part Heading text + rule, Service Name label, Provider Name shading, contact icons, master corner decoration, running head | `Pantone 7498 C` (id 302) |
| Paragraph Heading | `Pantone Neutral Black C` |
| Body / colon bullets / contact text | `800` |
| Regular text | `Black` |
| White text | `Paper` |
| Seen on the existing Social Welfare opener (page 13) | `Pantone 7621 C` |

**Colours for chapters 2-7 are NOT fixed.** Only Chapter 1 = `Pantone 7498 C` is confirmed.
- Unused Pantone swatches in v06 are candidates only: 072 C, 137 C, 298 C, 3298 C, 381 C, 652 C, 7590 C. `Pantone 3298 C` was used only as a **test** colour in the round-5 job B run.
- **The user must confirm each chapter's colour** before a job uses it. Never invent a mapping. If the user has not answered, stop and ask.

## 7. Target chapters (from the DOCX files)
| DOCX | Chapter subject | Status in v06 |
|---|---|---|
| Chapter 01 | Access to Women & Child Care & Family Support Services | not in book (job B builds it) |
| Chapter 02 | Access to Social Welfare & Protection Services | opener only (page 13) + master `2-...` |
| Chapter 03 | Access to Employment & Skill Development Services | not in book |
| Chapter 04 | Access to Information & Legal Support Services | not in book |
| Chapter 05 | Access to Healthcare Services | not in book |
| Chapter 06 | Access to Financial Services | = the book's Chapter 1 "Access to Finance" (job A replaces it) |
| Chapter 07 | Access to Identity & Travel Document Services | not in book |

The book numbers Finance as Chapter 1, but the DOCX calls it 06. **Chapter numbering, order and opener titles are user decisions.** Record a mismatch note and ask; do not renumber on your own.

## 8. Expected template findings (not bugs; never "fix", relink or delete)
- 3 links are missing: the cover EPS and 2 PNGs on pages V and VII.
- The foreword on page V has Lorem Ipsum and an overset story (35473).
- Story 5846 is overset (Agrani branch table).
- The TOC (page IX) is a static table: a new chapter is not listed until the TOC is updated (only with the user's approval, via `get_table_info` / `set_table_cell`).

## 9. Mapping DOCX content to slots (record a mismatch note when a rule does not fit)
- Provider: Part Heading / Provider Name / Regular description / Paragraph Heading sections, in the template order.
- `Label: value` items go to Colon Bullets or Service Name Numbered as `label`/`value` edits, never as plain `text`.
- Contact lines go through `replace_contact_block` with types address/web/email/phone.
  - Fax has no icon: use `typeAliases {fax:'phone'}` or `extraIcons`, and record a note.
  - Two lines of a type the template block already has (e.g. Helpline + Phone): `extraIcons` cannot add them. Put both on the one phone line, e.g. `+8801842773300 (Helpline); +8801852258855`, and record a note.
  - `Email:` / `Website:` labels and `https://` duplicate the icon's meaning and hit the GREP trap. Dropping them is a content change: **list it as a mismatch and ask the user**. The pending convention from the last accepted job: drop the label/scheme and note it.
  - A long address can wrap: retry with `wrapPolicy:'hangingIndent'`. Any line pushed into overset is rolled back (`content-replace.md` step 6.3).

## 10. Open user decisions (never guess; list them in every report)
- Chapter colours for chapters 2-7 (Ch1 = `Pantone 7498 C`; `Pantone 3298 C` was a test colour only).
- Chapter numbering and the TOC on page IX (the book already has a "Chapter 2 / Access to Social Welfare" opener).
- Dropping URL schemes and colon labels (`https://`, `Head Office:`, `Email:`) in contact lines.
- Combining two phone numbers on one contact line.
- Shortened running heads and opener-title frame growth (illustration moved).
- New chapters have no opener artwork; they keep Chapter 1's finance icon set.
- Source sections with no template slot (e.g. "Government Services", "Objectives", "BNSK Field Offices") get a mismatch note. Do not invent new styles.
- Template sections the source does not have (e.g. "Documents Requirement", branch tables) are deleted only when the source clearly lacks them. Record each deletion.

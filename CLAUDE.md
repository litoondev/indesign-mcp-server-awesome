# InDesign MCP Server

MCP server for Adobe InDesign automation via COM (Windows) / AppleScript (Mac; untested). The flow is: Node writes a .jsx temp file, PowerShell calls `app.DoScript`, and the script writes a result file.

## Architecture
- `src/bridge/` is the ExtendScript execution engine.
  - `index.ts`: the bridge. `runScript` returns a ScriptResult **object** `{success, data?, error?}`, not a string. It also handles timeouts, the busy lock and `probe()`.
  - `wrapExtendScript.ts`: wraps each script with the polyfill, helpers, document targeting (`WrapOptions.targetDocument`), POINTS/NEVER_INTERACT, the undo group and the in-script write guard.
  - `extendScriptHelpers.ts`: `__resolveDocument()` (takes **no** argument; it reads `__TARGET_DOCUMENT_ID`), `__ok`, `__fail(msg, code)`, `__itemById`, `__findStyle`, `__mcpAssertWritable`, and others.
  - `jsonPolyfill.ts`: JSON is undefined in DoScript; `JSON.parse` uses `[].constructor.constructor`, not `eval`.
  - `safety.ts`: the single write-path policy (write roots, the Downloads rule, the protected master).
  - `toolDispatch.ts`: `invokeTool` and the central `document_id` injection. Failures keep `data` (blockers, mismatches).
  - `jsStr.ts`, `documentTarget.ts`.
- `src/tools/` holds the tool modules: document, page, text, style (+ `chapterTheme.ts`), table, image, color, export, template, batch, content (+ `safeContent.ts`).
  - Helper modules: `textPipelineShared.ts`, `batchC_layoutKit.ts`, `batchB_writePolicy.ts`.
- `src/index.ts`: the MCP entry point (tool registry).

## Key patterns
- Pass `document_id` (preferably the full path) to every tool. Inside scripts use `__resolveDocument()`, never `app.activeDocument`.
- Mutating scripts pass `undoName` (one undo step + write guard) or `mutating:true` via RunOptions. Units are points; bounds are page-relative.
- Return results with `__ok(data)` / `__fail(message, code)`.
- Interpolate every value with `jsStr` / `jsNum`. Do not write raw `\u2028` in regex literals; the Write tool turns it into the literal character and breaks the build.

## Content-tool contracts (round 5; the skills rely on these)
- `replace_paragraphs` / `replace_contact_block` undo any write that creates new overset text by default (`applied:false, rolledBack:true`, mismatch `pushed into overset`). `allowOverset:true` keeps it; use it only when `continue_story` follows immediately.
- The ':' GREP guard refuses text that `.+(?<=:)` would bold wrongly (2+ colons, or a ':' the template line lacks) unless `acceptGrepEffects:true`.
- `theme_chapter` swaps shading/border colours and tints on the duplicated styles and rolls back a `textReplace` that would overset a master frame (`textReplaceOverset`).
- `continue_story` never shrinks fonts or moves items; `cascade_reflow` is its deprecated alias. Open issue: the added frame defaults to the margin box (`frameGeometry:'margins'`), ~13 pt above the BRAC body frame.
- Open source issue: `src/tools/page.ts` (add_page) has an unparenthesised chained ternary in ExtendScript (qa-r5-02); `tests/harness/lint_ternary.mjs` does not scan it.

## Safety (non-negotiable)
- Never open, save or modify `.indd`/`.indt` files outside `test_fixtures\` and `test_output\`. **Never touch anything under `C:\Users\Litoondev\Downloads`.**
- `test_fixtures\BRAC_TEST_MASTER.indd` (a copy of the user's v06 book) is pristine: never open or save it.
  - Copy it to `test_fixtures\runs\<label>.indd` and work on the copy. v05 (`BRAC_TEST_V05.indd`) must not be used.
- Writes are limited to `INDESIGN_MCP_WRITE_ROOTS` (`;`-separated; default `test_fixtures\runs;test_output`). Only the user widens it.
- `_snapshots\` holds source snapshots (e.g. `2026-11-07_pre-review`). Never modify them. This folder is not a git repo.
- Close every document you opened. Close without saving unless the task says otherwise.
- InDesign is single-instance. Do not drive it while another session or harness is using it.
- After a timeout or `INDESIGN_BUSY`, call `probe_indesign` until it answers before retrying anything.

## Build, test, harness
```bash
npm run build                          # tsc -> dist/
npx tsc --noEmit                       # type check only
npx tsx --test tests/bridge.test.mjs   # unit tests (no InDesign)
node tests/harness/run.mjs <label> [--only=1,5,27] [--keep-open]   # live harness (drives InDesign)
```
- **After `npm run build`, start a new Claude session.** The MCP server loads `dist/` when the session starts, so running sessions keep the old tools.
- The harness uses `dist/`, so build first. It copies `BRAC_TEST_MASTER.indd` to `test_fixtures\runs\<label>.indd`, opens only the copy, and runs the scenarios (`run.mjs`, `regress_r2.mjs`, `regress_r3.mjs`) through `invokeTool`. It writes `test_output\runs\<label>\results.json` plus JPEGs, then closes the copy without saving.
  - It refuses v05 and any master over 100 MB.

## Workflow skills (read before any document job)
- `.claude/skills/brac-referral-template.md`: v06 book facts, ids, styles, colours, traps. **Read this first for BRAC.**
- `.claude/skills/content-replace.md`: replace existing content page by page with layout and formatting unchanged (backup, snapshot, replace_contact_block / replace_paragraphs, verify).
- `.claude/skills/master-template.md`: build a new chapter from the template chapter (duplicate_page, theme_chapter, apply_master, fill), and .indt templates.
- `.claude/skills/reference-design.md`: build new documents or pages that match a reference.

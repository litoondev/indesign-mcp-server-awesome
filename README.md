# indesign-mcp-server-awesome

An MCP (Model Context Protocol) server that lets Claude and other MCP clients automate **Adobe InDesign** on Windows (COM) — documents, pages, text, styles, tables, images, colours, export, templates and batch jobs — plus safe, verified content tools for real book production.

## Highlights
- **Safe content replacement**: `replace_paragraphs` / `replace_contact_block` keep paragraph styles, bold-label/roman-value patterns and anchored icons, and **roll back** any write that would leave hidden (overset) text.
- **New chapters from a template chapter**: `duplicate_page`, `theme_chapter` (chapter colour, styles, master), `apply_master`, `continue_story` for page-to-page overflow.
- **Verification**: `verify_page_invariants`, `check_overset_text`, `snapshot_document`, JPEG export.
- **Safety built in**: backups (`backup_document` / `restore_backup`), write-root guard, single undo step per tool, busy lock and timeouts.

## Requirements
- Windows with Adobe InDesign installed (macOS/AppleScript path is untested)
- Node.js 18+

## Install & build
```bash
npm install
npm run build
```

## Use with Claude Code / Claude Desktop
Add to your MCP config (adjust the path):
```json
{
  "mcpServers": {
    "indesign": { "command": "node", "args": ["C:/path/to/indesign-mcp-server-awesome/dist/index.js"] }
  }
}
```
Restart the client after every build — the server loads `dist/` at start-up.

## Write safety
Writes are limited to `INDESIGN_MCP_WRITE_ROOTS` (`;`-separated; default `test_fixtures\runs;test_output`). Set it to the folders you want the server to be allowed to save into.

## Workflow skills & prompts
- `.claude/skills/` — step-by-step workflows (content replacement, new chapter from template, reference-based design).
- `prompts/` — ready-to-use prompts for common jobs.
- `CLAUDE.md` — architecture and tool contracts.

## Tests
```bash
npx tsx --test tests/bridge.test.mjs        # unit tests, no InDesign
node tests/harness/run.mjs <label>          # live harness (needs a local test book in test_fixtures/)
```
The live harness expects a private test document that is not included in this repository.

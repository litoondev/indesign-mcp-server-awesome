# Architecture

Diagrams, data flow, and the layering rules. If you're adding a feature, start with [ROADMAP.md](ROADMAP.md) + [STRUCTURE.md](STRUCTURE.md); this doc is for when you need to understand *why* the pieces are where they are.

---

## 1. Layering (target)

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP CLIENTS                                                    │
│  Claude Code · ChatGPT · Cursor · any JSON-RPC client           │
└───────────────────────────────┬─────────────────────────────────┘
                                │ stdio (JSON-RPC 2.0)
┌───────────────────────────────▼─────────────────────────────────┐
│  src/index.ts  —  Tool registry · schema injection              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  src/core/dispatch                                              │
│  • batcher    (coalesce calls)                                  │
│  • cache      (memoize read-only probes)                        │
│  • lock       (single-instance guard)                           │
│  • retry      (timeout + INDESIGN_BUSY recovery)                │
└──────────────┬────────────────────────────────┬─────────────────┘
               │                                │
┌──────────────▼────────────┐       ┌───────────▼─────────────────┐
│  src/domains/*            │       │  src/io/*                   │
│  edit the document        │       │  external-world adapters    │
│                           │       │                             │
│  document · page · text · │       │  export  · extract  ·       │
│  style · table · image ·  │       │  snapshot · import          │
│  color  · content ·       │       │                             │
│  template · review · batch│       │                             │
└──────────────┬────────────┘       └───────────┬─────────────────┘
               │                                │
┌──────────────▼────────────────────────────────▼─────────────────┐
│  src/core/bridge                                                │
│  • wrapExtendScript   (polyfill · helpers · undo · write guard) │
│  • toolDispatch       (doc_id injection · AsyncLocalStorage)    │
│  • COM runner         (PowerShell → app.DoScript)               │
│  • safety             (write roots · protected master)          │
└──────────────┬────────────────────────────────┬─────────────────┘
               │                                │
┌──────────────▼───────────┐       ┌────────────▼────────────────┐
│  Adobe InDesign 2027     │       │  UI Automation (host OS)    │
│  ExtendScript (now)      │       │  PowerShell · window capture│
│  → UXP scripting (soon)  │       │  SendKeys · UIAutomation    │
└──────────────────────────┘       └─────────────────────────────┘
```

**Rule of flow**: a request goes down the left column, through the bridge, into InDesign (or into UI Automation for the review subsystem), and back up with a `{success, data, error}` result. Nothing short-circuits layers — a domain never writes a temp file directly, a bridge never knows what a "paragraph style" is.

---

## 2. Data flow — standard tool call

```
Client  ──RPC────▶  index.ts  ──▶  dispatch (resolve, batch?)  ──▶  domain tool
                                                                        │
                                                                        │ builds JS source
                                                                        ▼
                                                                  bridge.runScript
                                                                        │
                                                                        │ wrapExtendScript:
                                                                        │   • JSON polyfill
                                                                        │   • __resolveDocument()
                                                                        │   • undo group open
                                                                        │   • write guard
                                                                        │
                                                                        ▼
                                                                  PowerShell COM
                                                                        │
                                                                        ▼
                                                               InDesign app.DoScript
                                                                        │
                                                                        │ writes result.json
                                                                        ▼
                                                                  bridge reads result
                                                                        │
                                                                        ▼
                                                        { success, data?, error? }
                                                                        │
                                                                        ▼
Client  ◀────────────────────────────  index.ts  ◀── domain tool ◀──────┘
```

Timing budget (today, no batcher):

| Step | ms |
|---|---|
| Node → .jsx write | 1–5 |
| PowerShell spawn | 50–150 |
| COM marshaling | 20–80 |
| `app.DoScript` | 20–300 (depends on op) |
| result file read | 1–5 |
| **round-trip floor** | **~100–500 ms per call** |

The batcher (Phase 2) collapses N dispatches into a single COM round-trip, so N ops cost roughly `(floor) + N·(DoScript body)` instead of `N·(floor + body)`.

---

## 3. Sequence — Review workflow (Phase 1 target)

```
User                MCP client (Claude/GPT)         MCP server                 InDesign + UI
 │                           │                           │                           │
 │ "resolve the comments"    │                           │                           │
 │──────────────────────────▶│                           │                           │
 │                           │ review_capture_panel      │                           │
 │                           │──────────────────────────▶│                           │
 │                           │                           │ PowerShell window-capture │
 │                           │                           │──────────────────────────▶│
 │                           │                           │       panel.png           │
 │                           │                           │◀──────────────────────────│
 │                           │   {image, uiIndex map}    │                           │
 │                           │◀──────────────────────────│                           │
 │                           │                                                       │
 │                           │  (vision model reads comments; picks #1)              │
 │                           │                                                       │
 │                           │  text_replace_paragraph   │                           │
 │                           │──────────────────────────▶│  app.DoScript (fix)       │
 │                           │                           │──────────────────────────▶│
 │                           │                           │◀──────── ok ──────────────│
 │                           │                           │                           │
 │                           │  document_save            │                           │
 │                           │──────────────────────────▶│──────────────────────────▶│
 │                           │                           │◀──────── ok ──────────────│
 │                           │                                                       │
 │  "resolve comment #1?"    │                           │                           │
 │◀──────────────────────────│                                                       │
 │        yes                │                                                       │
 │──────────────────────────▶│                                                       │
 │                           │  review_reply(1, "Done")  │                           │
 │                           │──────────────────────────▶│  UI automation (SendKeys) │
 │                           │                           │──────────────────────────▶│
 │                           │  review_resolve(1)        │                           │
 │                           │──────────────────────────▶│  UI automation (click)    │
 │                           │                           │──────────────────────────▶│
 │                           │                                                       │
 │                           │  (loop: next comment)                                 │
```

Each comment resolution is a transaction: edit → save → reply → resolve. If any step fails, we stop and surface state, we never half-resolve.

---

## 4. Safety flow

Every write passes through this gate before reaching InDesign:

```
tool handler
    │
    ▼
wrapExtendScript   (injects __mcpAssertWritable guard)
    │
    ▼
runtime check:  is target path inside INDESIGN_MCP_WRITE_ROOTS?
    │
    ├─ yes  →  proceed
    │
    └─ no   →  __fail("write outside sanctioned roots", "SAFETY_WRITE_ROOT")
                                │
                                ▼
                     tool returns { success: false, error: ... }
```

Also blocked unconditionally:
- `BRAC_TEST_MASTER.indd`
- `BRAC_TEST_V05.indd`
- anything under `C:\Users\Litoondev\Downloads\`
- anything inside `_snapshots\`

These rules live in `src/bridge/safety.ts` and the guard script `__mcpAssertWritable` injected by `wrapExtendScript.ts`. Changes to either need an ADR.

---

## 5. Where new code lands (short version)

| Kind of work | Folder |
|---|---|
| Edits a document | `src/domains/<noun>/` |
| Reads/writes an external file or screenshot | `src/io/<channel>/` |
| Changes dispatch, safety, bridge, memory, logging | `src/core/<subsystem>/` |
| Reusable `.jsx` or `.ps1` fragment | `scripts/<engine>/` |
| Human-facing SOP / skill | `.claude/skills/*.md` |
| Non-obvious decision | `docs/decisions/NNNN-*.md` |

Full decision tree with examples: [STRUCTURE.md](STRUCTURE.md).

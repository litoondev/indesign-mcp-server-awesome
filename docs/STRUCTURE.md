# Structure — Where does this go?

A new feature arrives. This doc picks the folder in under a minute. If it can't, you write an ADR and update this page.

See also: [ROADMAP.md](ROADMAP.md) (vision + phases), [ARCHITECTURE.md](ARCHITECTURE.md) (diagrams).

---

## 1. The decision tree

```
A new feature request. Ask, in order:

Q1. Does it edit the open InDesign document?
    ├─ Yes  → src/domains/<nearest noun>/
    └─ No   → Q2

Q2. Does it read from or write to the outside world
    (local files, screenshots, HTTP, cloud, OS APIs)?
    ├─ Yes  → src/io/<channel>/
    └─ No   → Q3

Q3. Does it change HOW tools are dispatched, safety-checked,
    cached, batched, retried, logged?
    ├─ Yes  → src/core/<subsystem>/
    └─ No   → Q4

Q4. Is it a reusable .jsx or .ps1 fragment many tools call?
    ├─ Yes  → scripts/<engine>/
    └─ No   → Q5

Q5. Is it an SOP a human (or Claude) follows end-to-end?
    ├─ Yes  → .claude/skills/<name>.md
    └─ No   → docs/decisions/NNNN-*.md  (you're in new territory; ADR first)
```

---

## 2. Target folder layout

```
I:\Indesign\
├── src\
│   ├── index.ts                   MCP entry + tool registry
│   ├── types.ts                   shared types
│   │
│   ├── core\                      framework (rarely changes)
│   │   ├── bridge\                ← current src/bridge/
│   │   │   ├── index.ts
│   │   │   ├── wrapExtendScript.ts
│   │   │   ├── toolDispatch.ts
│   │   │   ├── documentTarget.ts
│   │   │   ├── extendScriptHelpers.ts
│   │   │   ├── jsStr.ts
│   │   │   └── jsonPolyfill.ts
│   │   ├── safety\
│   │   │   └── writePolicy.ts     ← current src/bridge/safety.ts
│   │   ├── dispatch\              NEW
│   │   │   ├── batcher.ts         coalesce N ops into one DoScript
│   │   │   ├── cache.ts           memoize read-only probes
│   │   │   ├── lock.ts            single-instance guard
│   │   │   └── retry.ts           busy / timeout recovery
│   │   ├── memory\                ← current src/memory/
│   │   │   ├── observer.ts
│   │   │   └── store.ts
│   │   └── telemetry\             NEW
│   │       └── log.ts             structured JSONL per tool call
│   │
│   ├── domains\                   business features that touch the doc
│   │   ├── document\              document.ts
│   │   ├── page\                  page.ts
│   │   ├── text\                  text.ts + textPipelineShared.ts
│   │   ├── style\                 style.ts + chapterTheme.ts
│   │   ├── table\                 table.ts
│   │   ├── image\                 image.ts
│   │   ├── color\                 color.ts
│   │   ├── content\               content.ts + safeContent.ts
│   │   ├── template\              template.ts
│   │   ├── batch\                 batch.ts + batchB + batchC
│   │   └── review\                NEW — comment loop
│   │       ├── capture.ts         screenshot the Review panel
│   │       ├── parse.ts           shape vision output
│   │       ├── reply.ts           UI automation: type reply
│   │       ├── resolve.ts         UI automation: click resolve
│   │       ├── probeCache.ts      local review cache probe (bonus)
│   │       └── workflow.ts        orchestration loop
│   │
│   └── io\                        external-world adapters
│       ├── export\                export.ts
│       ├── extract\               extract.ts + python bridge
│       ├── import\                NEW — placeholder
│       └── snapshot\              NEW — hash + diff indd on disk
│
├── scripts\
│   ├── extendscript\              reusable .jsx fragments
│   ├── powershell\                NEW — window capture, SendKeys helpers
│   └── migrate\                   one-off migration scripts
│
├── docs\
│   ├── ROADMAP.md
│   ├── ARCHITECTURE.md
│   ├── STRUCTURE.md               this file
│   ├── README.md
│   └── decisions\                 ADRs
│       └── 0001-review-comments.md
│
├── python\                        kept as sibling; used via src/io/extract/
├── test_fixtures\                 safety-protected; harness copies from here
├── test_output\                   harness result dir
├── tests\                         unit + harness
├── .claude\skills\                human-facing SOPs
└── CLAUDE.md                      project rules (points here)
```

---

## 3. Worked examples

Twenty concrete asks mapped to folders. If yours isn't here, follow the tree.

| Feature | Lands in |
|---|---|
| "Read PDF form fields" | `src/io/extract/pdfForms.ts` |
| "Apply drop-cap style" | `src/domains/style/dropCap.ts` |
| "Batch 10 tool calls as one" | `src/core/dispatch/batcher.ts` |
| "Screenshot the Review panel" | `src/domains/review/capture.ts` |
| "Reply to a review comment via UI" | `src/domains/review/reply.ts` |
| "Find local review cache" | `src/domains/review/probeCache.ts` |
| "Save a snapshot of an .indd on disk" | `src/io/snapshot/save.ts` |
| "Diff two snapshots" | `src/io/snapshot/diff.ts` |
| "Add structured JSONL logs per tool call" | `src/core/telemetry/log.ts` |
| "Memoize probe_indesign within a turn" | `src/core/dispatch/cache.ts` |
| "Teach bridge to recover from INDESIGN_BUSY" | `src/core/dispatch/retry.ts` |
| "New .jsx helper: safe findText" | `scripts/extendscript/safeFindText.jsx` |
| "PowerShell window handle helper" | `scripts/powershell/findWindow.ps1` |
| "Add a new chapter theme colour" | `src/domains/style/chapterTheme.ts` |
| "Resolve a BRAC comment end-to-end" | `.claude/skills/review-loop.md` + glue in `src/domains/review/workflow.ts` |
| "Convert .indd to IDML on export" | `src/io/export/idml.ts` |
| "Import xlsx contacts into a table" | `src/io/extract/xlsx.ts` + `src/domains/table/fillFromExtract.ts` |
| "Pin the active InDesign process" | `src/core/dispatch/lock.ts` |
| "Switch from ExtendScript to UXP for `color`" | `src/domains/color/uxp/` (pilot) |
| "Something genuinely new, no folder fits" | `docs/decisions/NNNN-<title>.md`, then place |

---

## 4. Rules that override the tree

1. **Safety changes always go through `src/core/safety/`.** No domain patches write rules inline.
2. **UI Automation lives in `src/domains/review/` for now.** If a second domain needs it, promote the helpers to `src/core/uia/` and update this page.
3. **Python helpers stay in `python/`.** The TS side talks to them through `src/io/extract/` only. Never spawn Python from a domain tool.
4. **No tool file over ~400 lines.** Split by sub-noun (see `text/` → `textPipelineShared.ts`).
5. **Every new folder gets an `index.ts`** that `src/index.ts` imports; keep registration central.

---

## 5. When the tree can't answer

If none of Q1–Q5 fits, you're in genuinely new territory. Do this:

1. Write `docs/decisions/NNNN-<title>.md` — Context / Options / Decision / Consequences.
2. Place the code where the ADR says.
3. Update this file's decision tree or examples so the next person doesn't have to re-decide.

The index of ADRs lives in `docs/decisions/README.md` (create on first ADR).

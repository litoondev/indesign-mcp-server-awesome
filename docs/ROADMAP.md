# InDesign MCP — Roadmap

*Owner: Lead plugin dev. Last updated: 2026-11-12.*

This is the north star. Every feature request, every refactor, every "where does this go?" starts here.

Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) (diagrams, data flow), [STRUCTURE.md](STRUCTURE.md) (decision tree), [decisions/](decisions/) (ADRs).

---

## 0. North Star

Make the InDesign MCP server the fastest, safest, most organized automation layer for Adobe InDesign publishing work.

Three guarantees we never break:

1. **Safety first** — never touch what wasn't asked for. Writes stay inside sanctioned roots (`test_fixtures\runs\`, `test_output\`, user-configured `INDESIGN_MCP_WRITE_ROOTS`). `BRAC_TEST_MASTER.indd` and `Downloads\` are untouchable.
2. **Deterministic results** — `__ok(data)` or `__fail(message, code)`. No silent half-successes. Mutating tools pass `undoName` and roll back on overset/mismatch where the contract says so.
3. **Instant placement** — any new feature has exactly one correct folder. The decision tree in [STRUCTURE.md](STRUCTURE.md) decides; if it can't, an ADR records the gap before code lands.

---

## 1. Current state (2026-11-12 snapshot)

### What exists

| Layer | Where | What it does |
|---|---|---|
| MCP transport | `src/index.ts` | stdio server, tool registry, `@modelcontextprotocol/sdk@1.12` |
| Bridge | `src/bridge/` | wraps `.jsx`, runs `app.DoScript` via PowerShell COM, writes result file |
| Tools (~150) | `src/tools/*.ts` | flat per-domain files: document, page, text, style, table, image, color, export, template, batch, content, extract, memory |
| Content IO | `python/brac_extract/` + `src/tools/extract.ts` | reads docx / xlsx / pdf source content |
| Safety | `src/bridge/safety.ts` | write-root policy, protected master, Downloads block |
| Memory | `src/memory/` | observer + store for cross-tool hints |
| Skills | `.claude/skills/*.md` | BRAC template, content-replace, master-template, reference-design |
| Tests | `tests/bridge.test.mjs`, `tests/harness/run.mjs` | unit + live harness driving real InDesign |

### What hurts (and must get fixed)

1. **COM roundtrip overhead** — every tool call = temp file write + DoScript + result file read (~200–500 ms baseline). Batching would eat that.
2. **Flat `src/tools/`** — `batch.ts`, `batchB_writePolicy.ts`, `batchC_layoutKit.ts` is already sprawl. 10 more features and nothing has a home.
3. **No Review/Comments subsystem** — Share for Review is the next big ask; nothing there yet.
4. **ExtendScript engine** — slow string ops, no async, no modern JS. UXP scripting is the escape hatch, but it's a rewrite.
5. **Observability thin** — hard to tell after the fact which tools fired, when, with what args.

---

## 2. Target shape (where we're going)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full diagram set. Short version:

```
MCP clients  →  src/index.ts  →  src/core/dispatch  →  src/domains/* ──┐
                                                       src/io/*        │
                                                                       ▼
                                                src/core/bridge  ──→  InDesign (ExtendScript now, UXP later)
                                                                 \
                                                                  →  UI Automation (PowerShell / SendKeys)
```

Three top-level buckets under `src/`:

- **`core/`** — framework: bridge, dispatch, safety, memory, telemetry. Rarely changes. Changes here are reviewed hard.
- **`domains/`** — business features that edit the document: document, page, text, style, table, image, color, content, template, **review (new)**, batch.
- **`io/`** — external-world adapters: export, extract, snapshot, import. In and out of InDesign.

---

## 3. Roadmap — phases

Each phase has a clear exit criterion. No phase ships without it. Phases 0–2 are near-term; 3–5 are the next quarter.

### Phase 0 — Groundwork *(1–2 days; in progress)*

**Goal**: documentation and decision framework ready so the next feature has an obvious home.

- [x] `docs/ROADMAP.md` (this file)
- [x] `docs/ARCHITECTURE.md` with layer + sequence diagrams
- [x] `docs/STRUCTURE.md` with the decision tree
- [x] `docs/decisions/0001-review-comments.md` (ADR for the vision path)
- [x] `docs/README.md` index
- [x] `CLAUDE.md` points at `docs/` for anyone newer than the last PR

**Exit**: next feature request → correct folder in under one minute, without asking me.

### Phase 1 — Review subsystem MVP *(3–5 days)*

**Goal**: read + resolve Share-for-Review comments without any Adobe API, driven by Claude Code / ChatGPT vision.

Chosen path: vision + UI automation (see ADR-0001). Local-cache probe ran in parallel; verdict was `ambient_webview_cache_only` — vision path remains primary.

- [x] `src/domains/review/capture.ts` — MCP tool: `review_capture_panel` → screenshot full window or right-panel slice
- [x] `scripts/powershell/window_capture.ps1` — find InDesign window handle, GDI BitBlt
- [x] `src/domains/review/probeCache.ts` — MCP tool: `review_probe_cache` (diagnostic, not primary path)
- [x] `scripts/powershell/ui_automation.ps1` — focus / click / type / key / wheel engine with INDESIGN_MCP_UI_DISABLE kill-switch and bounds validation
- [x] `src/domains/review/uiAutomation.ts` — shared PS runner, `UiAction` types, `parseBounds`
- [x] `src/domains/review/reply.ts` — MCP tool: `review_reply(x, y, text, submit?, windowBounds?)`
- [x] `src/domains/review/resolve.ts` — MCP tool: `review_resolve(x, y, windowBounds?)`
- [x] `src/domains/review/action.ts` — MCP tool: `review_action(actions[])` escape hatch
- [x] `src/domains/review/session.ts` — session-state tools: begin / register_comments / update / get / list / end (audit trail + resume)
- [x] `.claude/skills/review-loop.md` — human-facing SOP (preconditions, loop steps, failure modes, "never do")
- [ ] Live end-to-end verification on a copy of BRAC book (needs real InDesign session)
- [ ] Harness scenario: scripted 5-comment test review (needs captured fixture images)

**Exit**: 5-comment review resolved on a test-fixture copy with no manual clicking.

### Phase 2 — Speed *(2–3 days)*

**Goal**: 2–5× faster multi-op sessions. No behavior change.

- [ ] `src/core/dispatch/batcher.ts` — coalesce consecutive non-dependent tool calls into one `DoScript`
- [ ] `src/core/dispatch/cache.ts` — memoize read-only probes (`probe_indesign`, `list_pages`, `list_open_documents`) for the turn
- [ ] Switch result passing from temp file → `DoScript` return string where size allows
- [ ] `tests/perf/baseline.mjs` — timings for a 20-op BRAC fill before/after

**Exit**: BRAC "fill one chapter" harness run drops ≥ 30 %. No regressions on `tests/harness/run.mjs`.

### Phase 3 — Reorganization *(3–4 days)*

**Goal**: fold `src/tools/*` into `src/domains/*` + `src/io/*` + `src/core/*` without breaking a single tool.

- [ ] One PR per subsystem (document → `domains/document/`, text → `domains/text/`, ...)
- [ ] Old paths re-export from new (`src/tools/text.ts` re-exports `src/domains/text/index.ts`) for one release
- [ ] CLAUDE.md updated to point at new layout
- [ ] Deprecation note on old paths; removal scheduled in Phase 5

**Exit**: all harness scenarios pass; new layout live; zero breaking changes to MCP consumers.

### Phase 4 — UXP migration pilot *(1 week, exploratory)*

**Goal**: prove one domain on UXP scripting, measure the gain honestly.

- [ ] Pick smallest-surface domain (`color` or `page`) as pilot
- [ ] Rewrite against UXP scripting API in InDesign 2027
- [ ] Benchmark vs ExtendScript equivalent on identical operations
- [ ] ADR-0002: full migrate / partial / abort, with numbers

**Exit**: an ADR with a decision backed by real numbers.

### Phase 5 — Telemetry + polish *(2–3 days)*

- [ ] `src/core/telemetry/` — structured JSONL logs per tool call (name, args hash, ms, result, error)
- [ ] `tools/telemetry_recent` MCP tool → last N calls, timings, errors
- [ ] Remove deprecated flat imports from Phase 3

**Exit**: one command surfaces why the last session was slow.

---

## 4. Decision framework (keep it in muscle memory)

When a new feature request arrives:

1. Open [STRUCTURE.md](STRUCTURE.md) → decision tree → pick the folder.
2. If no folder fits → write an ADR in `docs/decisions/` before coding.
3. Name the tool `<domain>_<verb>_<object>` (e.g. `review_capture_panel`, `text_replace_paragraph`).
4. Ship with: Zod schema, `__ok`/`__fail` return, one unit test, harness scenario if mutating, skill-doc line if humans invoke it.
5. If you touched a pattern (bridge, safety, dispatch), update `CLAUDE.md` and the roadmap phase checkbox in the same PR.

---

## 5. Conventions

**Naming**

- Tools: `<domain>_<verb>_<object>` — `review_capture_panel`, `document_open`, `text_replace_paragraph`.
- Files: camelCase matching the dominant noun — `captureViaUIA.ts`, `writePolicy.ts`.
- ADRs: `NNNN-kebab-title.md` under `docs/decisions/`.

**Safety is not optional**

- Every mutating tool passes `undoName`.
- Every write path checks `__mcpAssertWritable`.
- No feature touches `BRAC_TEST_MASTER.indd`, v05, or `Downloads\`.
- Documents the tool opens, the tool closes — without saving unless the task said so.

**Doc hygiene**

- Feature lands → tick its roadmap checkbox + update CLAUDE.md if the pattern changed.
- Non-obvious decision → ADR, not commit-message trivia.

---

## 6. Open questions (pin these; they block downstream work)

1. **UXP scripting** — does InDesign 2027's UXP API expose the Review/Comments panel? Needs a 30-min probe before Phase 1 locks in vision path.
2. **Local review cache** — path and format in `%APPDATA%\Adobe\InDesign\Version 20.0\`? 30-min spike as part of Phase 1.
3. **Python folder location** — does `python/` stay sibling, or fold under `src/io/extract/python/`? Decide in Phase 3.
4. **SendKeys reliability** — real-session test needed for InDesign 2027 Review panel focus behaviour before Phase 1 reply/resolve tools ship.

---

## 7. Changelog

| Date | Change |
|---|---|
| 2026-11-12 | Roadmap drafted. Phase 0 kicked off. Phases 1–5 scoped. |

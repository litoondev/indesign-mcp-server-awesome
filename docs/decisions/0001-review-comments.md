# ADR-0001 — Reading Share-for-Review comments without an Adobe API

*Status: Accepted · Date: 2026-11-12 · Owner: Lead plugin dev*

## Context

The project needs to read, reply to, and resolve review comments on InDesign documents shared via Adobe's **Share for Review** feature (InDesign 2027). Reviewers comment through an Adobe cloud link; comments appear in the in-app **Review panel**.

Adobe's review service is cloud-hosted. There is no public API available to this project, and getting one is not on the table. ExtendScript DOM doesn't expose Share-for-Review comments. UXP scripting may or may not — undocumented and unverified as of this ADR.

The user explicitly rejected a PDF-export + parse detour ("অনেক ভ্যাঙ্গাম না করে"). They want a path driven by Claude Code / ChatGPT, fast, with minimal setup.

## Options considered

### A. Adobe Review REST API (cloud, IMS OAuth)
- **Pro**: official, stable, structured data.
- **Con**: requires Adobe Developer Console app registration, OAuth plumbing, token refresh, and user stated this is not possible for them.
- **Verdict**: blocked.

### B. UXP scripting in InDesign 2027
- **Pro**: in-process, modern JS, potentially faster than ExtendScript.
- **Con**: unknown whether the Comments panel is exposed in the UXP scripting API. Needs probing. A whole-stack rewrite to UXP is a Phase 4 bet, not a Phase 1 one.
- **Verdict**: parallel probe (30 min) during Phase 1; not the primary path.

### C. Vision + UI Automation (chosen)
- Screenshot the Review panel → vision model (Claude / GPT) reads the text → MCP tools execute UI automation for reply + resolve.
- **Pro**: works today. Current vision models (Claude Opus 4.7, GPT-4o) read panel text reliably. No auth, no Adobe setup.
- **Con**: fragile to Adobe UI changes; SendKeys reliability needs real-session testing; scrolling the panel needs extra logic.
- **Verdict**: start here.

### D. Local review cache scrape
- Adobe locally caches review state somewhere under `%APPDATA%\Adobe\InDesign\Version 20.0\`.
- **Pro**: fastest and most deterministic if the format is readable.
- **Con**: undocumented; may be SQLite / opaque binary; Adobe can change it in any update.
- **Verdict**: parallel 30-min spike during Phase 1; if it hits, promote to primary and keep C as fallback.

### E. PDF export + annotation parse
- **Pro**: tooling exists.
- **Con**: user rejected.
- **Verdict**: dropped.

## Decision

**Go with C (Vision + UI Automation) as the primary path for Phase 1**, with B and D running as timeboxed parallel probes. If either B or D returns a clean API/file, we migrate the implementation behind the same MCP tool surface.

Implementation lands in `src/domains/review/`:

- `capture.ts` — MCP tool: `review_capture_panel` → PNG to scratchpad.
- `parse.ts` — shape vision output into `{ spread, author, text, anchorHint, uiIndex }[]`.
- `reply.ts` — MCP tool: `review_reply(uiIndex, text)` via SendKeys / UIAutomation.
- `resolve.ts` — MCP tool: `review_resolve(uiIndex)` via click automation.
- `workflow.ts` — orchestrator: capture → list → ask user → edit → save → reply → resolve → next.

Helper scripts land in `scripts/powershell/`.

## Consequences

**Good**

- Ships in days, not weeks.
- The MCP tool contract (`review_capture_panel`, `review_reply`, `review_resolve`) stays the same regardless of whether the backend ends up being vision, UXP, or cache. Future migration is internal.
- Uses existing Phase-2 batching and safety infrastructure unchanged.

**Bad / risks**

- **UI fragility.** Any Adobe UI change to the Review panel breaks capture coordinates or SendKeys focus. Mitigation: coordinates are computed per-session from window geometry, never hard-coded.
- **Speed ceiling.** Screenshot + vision roundtrip is ~1–3 s per comment vs. ~50 ms for a structured API. Acceptable for a human-in-the-loop workflow that asks "resolve next?" between items.
- **Save-first rule.** Every edit must be saved before reply/resolve, per user requirement ("প্রথমে সেভ করবা"). The workflow enforces this; no `review_resolve` fires without a prior `document_save` ack.
- **User approval between comments.** The workflow stops after each resolution and surfaces a `continueNext?` question to the client. No auto-advance.

**Follow-up (tracked in ROADMAP Phase 1 open questions)**

- Real-session SendKeys reliability test on InDesign 2027 Review panel.
- 30-min spike for local cache location.
- 30-min spike for UXP scripting API surface.
- If cache spike hits, author ADR-0002 switching primary path.

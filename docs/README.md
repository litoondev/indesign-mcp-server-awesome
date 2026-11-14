# docs/ — Index

The project's thinking lives here. Read in this order:

1. **[ROADMAP.md](ROADMAP.md)** — north star, current state, phased plan, open questions. Start every new feature here.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — layer diagram, data flow, review-workflow sequence, safety flow. Read when you need to understand *why* a piece is where it is.
3. **[STRUCTURE.md](STRUCTURE.md)** — the decision tree. Read every time you add code; it picks the folder in under a minute.
4. **[decisions/](decisions/)** — ADRs for non-obvious choices. One per decision, numbered.

## When to update what

| You just... | Update |
|---|---|
| Finished a phase milestone | tick the checkbox in `ROADMAP.md`; append the changelog row |
| Added a new folder or top-level concept | add it to `STRUCTURE.md` (tree + examples) and `ARCHITECTURE.md` (layer diagram) |
| Made a non-obvious design choice | write `decisions/NNNN-<title>.md`; link from `ROADMAP.md` if it moves a phase |
| Changed a pattern used by many tools (bridge, safety, dispatch) | bump the relevant section in `ARCHITECTURE.md` and the rules in `CLAUDE.md` |
| Added a human-facing SOP | create `.claude/skills/<name>.md`; mention it in the phase that introduced it |

The rule: no PR lands without the doc it implies. If the design is big enough to need explaining in a review, it's big enough to need an ADR or a roadmap tick.

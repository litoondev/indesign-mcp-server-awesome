# Skill — Review loop (resolve Share-for-Review comments)

**When to use**: the user wants Share-for-Review comments on an InDesign document read, answered, and resolved. Typical ask: "resolve the comments", "read the review comments and fix them", "reply to each comment".

**Read first**: [docs/decisions/0001-review-comments.md](../../docs/decisions/0001-review-comments.md) for *why* this loop looks the way it does. In short — no Adobe API; comments are read by vision from a screenshot; replies and resolves are UI automation; the user approves between comments.

**What the user sees**: progress one comment at a time. Nothing ambient. Never resolve two comments in a row without their yes.

---

## Preconditions

Before you start this loop, check and confirm:

1. **InDesign 2027 is running** with the target document open and the Review panel visible (right-side dock, showing cloud comments synced from Share for Review). If not, say so and ask the user to open them.
2. **Target document is a safe-to-edit copy** — a path inside `INDESIGN_MCP_WRITE_ROOTS` (defaults: `test_fixtures\runs`, `test_output`, or whatever the user configured). For BRAC, work on a copy under `test_fixtures\runs\<label>.indd`; `BRAC_TEST_MASTER.indd` is off-limits.
3. **`INDESIGN_MCP_UI_DISABLE` is not `1`** — the kill-switch. If set, abort and tell the user.

Confirm all three in one short line before the first tool call.

---

## The loop

### 0. Begin session

```
review_session_begin({ documentPath: "<absolute path>", label: "<short slug>" })
```

Keep the returned `sessionId`. Every later call in this loop passes it.

### 1. Capture the Review panel

```
review_capture_panel({ region: "right", panelWidth: 360 })
```

Why `region: "right"`: the Review panel is docked right. Capture the full window first time only if the panel's exact dock width is unknown; thereafter the right slice is plenty.

**Look at the PNG**. Read each visible comment: text, author, approximate anchor on the page (spread + rough area). For each comment, note the on-screen pixel coordinates of:

- the **Reply trigger** (the "Reply" link under the comment text, or the empty reply input if expanded);
- the **Resolve control** (the empty circle at the left edge of the card — a filled checkmark means already resolved);
- the **three-dot menu** if you'll need it.

Coordinates are absolute screen coordinates. The capture result's `captureBounds.left` + `captureBounds.top` is the origin of the image you're looking at; the `windowBounds` object is what later UI-automation tools should get as `windowBounds` for safety.

### 2. Register what you saw

```
review_session_register_comments({
  sessionId,
  capture: { outPath, windowBounds },
  comments: [
    { ordinal: 1, text: "Extra space", author: "...", spreadHint: "Spread#13",
      replyCoord: {x, y}, resolveCoord: {x, y} },
    { ordinal: 2, text: "Error in numbering the bullet points (1,2,3)", ... },
    ...
  ]
})
```

Ordinals are top-to-bottom as they appear in the panel. Only register comments whose **Resolve control is empty** — i.e. not already resolved.

### 3. For each pending comment, in order

Loop over comments with `status: "pending"`. For each:

#### 3a. Tell the user what this comment says

One short line: ordinal, author, text, and where on the page it points. No pre-emptive resolution.

#### 3b. Interpret the fix

If the comment is clear ("extra space", "fix typo in line X", "wrong colour on heading"), say in one sentence what you'll change in the document and ask for a go-ahead. Mark `review_session_update({ sessionId, ordinal, status: "editing", editSummary: "<what>" })`.

If the comment is **unclear** (vague, references something you can't locate, needs context), do NOT guess. Either:

- Ask the user what the reviewer likely meant, OR
- Post a reply back to the reviewer saying you need more detail:

  ```
  review_reply({ x, y, text: "Could you clarify? I can see <what you see> but am not sure which <thing> you mean.", windowBounds })
  ```

  Then `review_session_update({ sessionId, ordinal, status: "deferred", note: "awaiting clarification" })` and move to the next comment.

#### 3c. Apply the fix

Use the existing document-editing MCP tools (`text_replace_paragraph`, `replace_contact_block`, style/table/color tools, etc.) exactly as the content-replace and master-template skills describe. Preserve formatting and anchors; roll back on overset.

On success:

```
review_session_update({ sessionId, ordinal, status: "edited", editSummary: "<concise what was done>" })
```

#### 3d. Save

Save the document before touching the comment thread. The user's rule: **"প্রথমে সেভ করবা"** (save first).

```
document_save
```

Then:

```
review_session_update({ sessionId, ordinal, status: "saved" })
```

#### 3e. Reply

Post a short, honest reply. Default: "Done" (or "Fixed" with a one-line note when the fix was non-obvious). Match the language the reviewer used; for BRAC the reviewer writes in English, so reply in English.

```
review_reply({ x: replyCoord.x, y: replyCoord.y, text: "Done", windowBounds })
```

Record:

```
review_session_update({ sessionId, ordinal, status: "replied", replyText: "Done" })
```

#### 3f. Resolve

```
review_resolve({ x: resolveCoord.x, y: resolveCoord.y, windowBounds })
```

Record:

```
review_session_update({ sessionId, ordinal, status: "resolved" })
```

#### 3g. Ask before continuing

Use `wrap_up` to ask the user: *"Comment #N resolved. Move on to #N+1?"*. Give them a button for yes, a button for "pause here". Do NOT auto-advance.

### 4. Recapture every few comments

Panel scroll position, new comments, or Adobe's UI reshuffling can invalidate stored coordinates. After every 3 resolutions, or whenever a coordinate seems off (click goes to wrong place), run `review_capture_panel` again and `review_session_register_comments` with the fresh coordinates.

### 5. End the session

When the user says stop, or the comment list is empty:

```
review_session_end({ sessionId, note: "..." })
```

Return the summary to the user: counts per status, and the list of resolved comments with their replies.

---

## Failure modes and how to handle them

| Symptom | Likely cause | Fix |
|---|---|---|
| `review_capture_panel` → `NO_WINDOW` | InDesign not running / not visible | Ask the user to open InDesign; do not retry silently |
| Reply click lands on the wrong card | Panel scrolled since last capture | Recapture (step 4) |
| Reply submits but comment still shows as unresolved | Reviewer's own comment vs. a reply — resolve is a separate control | Run `review_resolve` explicitly |
| Vision can't read a comment (blurry, clipped, unusual font) | Panel width too narrow | Recapture with larger `panelWidth` |
| InDesign shows "Save?" dialog mid-loop | Document was modified outside the loop | Ask the user before answering it; UI automation never dismisses save prompts by itself |
| `UI_DISABLED` from any UI tool | `INDESIGN_MCP_UI_DISABLE=1` is set | Tell the user, do not override |

---

## Never do

- Never resolve a comment without first saving the document.
- Never reply "Done" to a comment you did not actually fix.
- Never process two comments in a row without the user's explicit continue.
- Never guess a comment's meaning when the comment references content you cannot see.
- Never touch `BRAC_TEST_MASTER.indd`, `BRAC_TEST_V05.indd`, or any file under `C:\Users\Litoondev\Downloads\`.
- Never run `review_action` with coordinates you did not derive from a recent capture + its windowBounds.

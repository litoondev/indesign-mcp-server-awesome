import { parseBounds, runUiActions, type UiAction } from "./uiAutomation.js";

/**
 * review_reply — post a reply to a Review-panel comment via UI automation.
 *
 * Inputs are absolute screen coordinates of the reply trigger (the "Reply"
 * link or the empty reply input) plus the reply text. A vision model names
 * the coordinates from the most recent review_capture_panel PNG and the
 * window bounds it returned.
 *
 * Flow:
 *   1. Focus InDesign (foreground the window so input lands there).
 *   2. Click the reply trigger coordinates.
 *   3. Type the reply text.
 *   4. Press Enter (submit=true, default) or leave it draft (submit=false,
 *      caller submits with a separate review_action if the UI needs it).
 *
 * Safety:
 *   • If windowBounds is provided, every coordinate is validated against
 *     it before PowerShell runs. Out-of-bounds aborts with no input sent.
 *   • INDESIGN_MCP_UI_DISABLE=1 short-circuits with UI_DISABLED.
 */
export function registerReviewReplyTools() {
  return {
    review_reply: {
      description:
        "Post a reply to a Review-panel comment. Takes the screen coordinates of the reply trigger (from a prior review_capture_panel), the reply text, and optional window bounds for safety. Focuses InDesign, clicks the trigger, types the text, and presses Enter to submit by default.",
      inputSchema: {
        type: "object" as const,
        properties: {
          x: { type: "integer", description: "Absolute screen X of the Reply trigger." },
          y: { type: "integer", description: "Absolute screen Y of the Reply trigger." },
          text: { type: "string", description: "Reply text to type into the field." },
          submit: { type: "boolean", description: "Press Enter after typing (default true). Set false to leave the reply drafted for a follow-up tool." },
          windowBounds: {
            type: "object",
            description: "Safety guard: { left, top, width, height } of the InDesign window; coordinates are validated against this. From review_capture_panel's windowBounds.",
            properties: {
              left: { type: "integer" },
              top: { type: "integer" },
              width: { type: "integer" },
              height: { type: "integer" },
            },
          },
          focusDelayMs: { type: "integer", minimum: 0, maximum: 2000, description: "Pause after focusing InDesign before the first click (default 200)." },
          titleMatch: { type: "string", description: "Substring to match the InDesign window title. Default 'Adobe InDesign'." },
        },
        required: ["x", "y", "text"],
      },
      handler: async (args: Record<string, unknown>) => {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be finite numbers");
        const text = typeof args.text === "string" ? args.text : "";
        if (!text) throw new Error("text is required and must be non-empty");
        const submit = args.submit === false ? false : true;
        const bounds = parseBounds(args.windowBounds);
        const focusDelayMs = typeof args.focusDelayMs === "number" && Number.isFinite(args.focusDelayMs) ? Math.round(args.focusDelayMs) : 200;
        const titleMatch = typeof args.titleMatch === "string" && args.titleMatch.trim().length > 0 ? args.titleMatch.trim() : undefined;

        const actions: UiAction[] = [
          { type: "focus" },
          { type: "sleep", ms: focusDelayMs },
          { type: "click", x: Math.round(x), y: Math.round(y) },
          { type: "sleep", ms: 180 },
          { type: "type", text },
        ];
        if (submit) {
          actions.push({ type: "sleep", ms: 120 });
          actions.push({ type: "key", name: "enter" });
        }

        const res = await runUiActions(actions, { bounds, titleMatch });
        return { submitted: submit && res.success, chars: text.length, ...res };
      },
    },
  };
}

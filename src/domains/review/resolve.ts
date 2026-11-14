import { parseBounds, runUiActions, type UiAction } from "./uiAutomation.js";

/**
 * review_resolve — mark a Review-panel comment as resolved via UI automation.
 *
 * Inputs are absolute screen coordinates of the resolve control (the empty
 * circle checkbox at the left edge of the comment card in InDesign 2027's
 * Review panel). A vision model names the coordinates from the most recent
 * review_capture_panel PNG and the window bounds it returned.
 *
 * Why not combined with review_reply? Two reasons:
 *   1. The user's workflow requires save-between-reply-and-resolve in some
 *      cases; splitting keeps the save point explicit and auditable.
 *   2. Some comments get resolved without a reply at all; splitting lets the
 *      caller skip the reply step without workarounds.
 *
 * Safety: same as review_reply (bounds validation, INDESIGN_MCP_UI_DISABLE).
 */
export function registerReviewResolveTools() {
  return {
    review_resolve: {
      description:
        "Mark a Review-panel comment as resolved by clicking its resolve control at the given screen coordinates (from a prior review_capture_panel). Focuses InDesign first; validates coordinates against window bounds when provided.",
      inputSchema: {
        type: "object" as const,
        properties: {
          x: { type: "integer", description: "Absolute screen X of the resolve control (the circle/checkbox on the comment card)." },
          y: { type: "integer", description: "Absolute screen Y of the resolve control." },
          windowBounds: {
            type: "object",
            description: "Safety guard: { left, top, width, height } of the InDesign window; coordinates are validated against this.",
            properties: {
              left: { type: "integer" },
              top: { type: "integer" },
              width: { type: "integer" },
              height: { type: "integer" },
            },
          },
          focusDelayMs: { type: "integer", minimum: 0, maximum: 2000, description: "Pause after focusing InDesign before the click (default 200)." },
          titleMatch: { type: "string", description: "Substring to match the InDesign window title. Default 'Adobe InDesign'." },
        },
        required: ["x", "y"],
      },
      handler: async (args: Record<string, unknown>) => {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be finite numbers");
        const bounds = parseBounds(args.windowBounds);
        const focusDelayMs = typeof args.focusDelayMs === "number" && Number.isFinite(args.focusDelayMs) ? Math.round(args.focusDelayMs) : 200;
        const titleMatch = typeof args.titleMatch === "string" && args.titleMatch.trim().length > 0 ? args.titleMatch.trim() : undefined;

        const actions: UiAction[] = [
          { type: "focus" },
          { type: "sleep", ms: focusDelayMs },
          { type: "click", x: Math.round(x), y: Math.round(y) },
        ];

        const res = await runUiActions(actions, { bounds, titleMatch });
        return { resolvedClickSent: res.success, ...res };
      },
    },
  };
}

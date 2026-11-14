import { parseBounds, runUiActions, type UiAction } from "./uiAutomation.js";

/**
 * review_action — escape hatch for arbitrary UI sequences.
 *
 * review_reply and review_resolve cover the common cases. When the vision
 * model needs something odd (scroll the panel, right-click a comment,
 * modifier-click to open a menu, type a multi-line reply then Tab then
 * click a submit button), it builds a custom action list and sends it here.
 *
 * Supported action types (see scripts/powershell/ui_automation.ps1 for the
 * full contract): focus, sleep, move, click, type, key, wheel.
 */
export function registerReviewActionTools() {
  return {
    review_action: {
      description:
        "Run an arbitrary sequence of UI-automation actions against the InDesign window: focus / sleep / move / click / type / key / wheel. Validates every coordinate against windowBounds when provided. Use for cases review_reply / review_resolve don't cover (scrolling the Review panel, right-click menus, multi-step submits).",
      inputSchema: {
        type: "object" as const,
        properties: {
          actions: {
            type: "array",
            description:
              "Ordered list of actions. Each item: { type: 'focus'|'sleep'|'move'|'click'|'type'|'key'|'wheel', ... }. See docs/decisions/0001-review-comments.md for the full shape.",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                x: { type: "integer" },
                y: { type: "integer" },
                ms: { type: "integer" },
                text: { type: "string" },
                name: { type: "string" },
                delta: { type: "integer" },
                button: { type: "string", enum: ["left", "right"] },
                double: { type: "boolean" },
                modifier: { type: "string", enum: ["shift", "ctrl", "alt", "cmd"] },
              },
              required: ["type"],
            },
          },
          windowBounds: {
            type: "object",
            description: "Safety guard: { left, top, width, height } of the InDesign window.",
            properties: {
              left: { type: "integer" },
              top: { type: "integer" },
              width: { type: "integer" },
              height: { type: "integer" },
            },
          },
          defaultSleepMs: { type: "integer", minimum: 0, maximum: 5000, description: "Pause inserted between actions when none is specified (default 120)." },
          titleMatch: { type: "string" },
        },
        required: ["actions"],
      },
      handler: async (args: Record<string, unknown>) => {
        const raw = args.actions;
        if (!Array.isArray(raw)) throw new Error("actions must be an array");
        const actions = raw as UiAction[];
        const bounds = parseBounds(args.windowBounds);
        const defaultSleepMs = typeof args.defaultSleepMs === "number" && Number.isFinite(args.defaultSleepMs) ? Math.round(args.defaultSleepMs) : undefined;
        const titleMatch = typeof args.titleMatch === "string" && args.titleMatch.trim().length > 0 ? args.titleMatch.trim() : undefined;
        return runUiActions(actions, { bounds, titleMatch, defaultSleepMs });
      },
    },
  };
}

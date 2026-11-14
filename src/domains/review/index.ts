import { registerReviewProbeTools } from "./probeCache.js";
import { registerReviewCaptureTools } from "./capture.js";
import { registerReviewReplyTools } from "./reply.js";
import { registerReviewResolveTools } from "./resolve.js";
import { registerReviewActionTools } from "./action.js";
import { registerReviewSessionTools } from "./session.js";

/**
 * Review subsystem — Phase 1 MVP tools.
 *
 * See docs/ROADMAP.md §Phase 1 and docs/decisions/0001-review-comments.md.
 * The SOP the assistant follows lives at .claude/skills/review-loop.md.
 *
 * Current surface:
 *   review_probe_cache               — diagnose on-disk review caches
 *   review_capture_panel             — screenshot the InDesign window for vision reading
 *   review_reply                     — click reply trigger + type + submit
 *   review_resolve                   — click the resolve control
 *   review_action                    — arbitrary UI-automation sequence
 *   review_session_begin             — start a resolve-loop session
 *   review_session_register_comments — record what vision read from a capture
 *   review_session_update            — advance a comment through its lifecycle
 *   review_session_get               — read session state
 *   review_session_list              — list sessions on disk
 *   review_session_end               — close the session; return summary
 */
export function registerReviewTools() {
  return {
    ...registerReviewProbeTools(),
    ...registerReviewCaptureTools(),
    ...registerReviewReplyTools(),
    ...registerReviewResolveTools(),
    ...registerReviewActionTools(),
    ...registerReviewSessionTools(),
  };
}

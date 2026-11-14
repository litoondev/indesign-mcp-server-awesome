import { recordLesson, type LessonSignal, type LessonContext } from "./store.js";

/**
 * Inspects a tool's raw handler result (whatever shape it has — string JSON,
 * object, error wrapper) and records one lesson if it contains a recognisable
 * mistake signal. Designed to be safe to call on every tool invocation:
 * unrecognised payloads produce no lesson.
 */

const MUTATING_TOOL_HINTS = new Set([
  "replace_paragraphs",
  "replace_contact_block",
  "continue_story",
  "cascade_reflow",
  "theme_chapter",
  "duplicate_page",
  "fill",
  "apply_master",
  "find_replace_text",
  "set_document_preferences",
  "run_script",
]);

const SKIP_CODES = new Set([
  "UNDO_NAME_MISMATCH",
  "INDESIGN_BUSY",
  "EXECUTION_TIMEOUT_STILL_RUNNING",
  "SAFETY",
]);

function toObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      const o = JSON.parse(t);
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

/** Extracts a lesson description + fix hint + signal from one result payload. */
function diagnose(tool: string, result: Record<string, unknown>): {
  signal: LessonSignal;
  mistake: string;
  fix?: string;
  context: LessonContext;
} | null {
  const data = (result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : null);
  const code = typeof result.code === "string" ? result.code : undefined;
  if (code && SKIP_CODES.has(code)) return null;

  const ctx: LessonContext = {};
  if (data) {
    if (typeof data.doc === "string") ctx.doc = data.doc;
    if (typeof data.docPath === "string") ctx.doc = data.docPath;
    if (typeof data.page === "number" || typeof data.page === "string") ctx.page = data.page as number | string;
    if (typeof data.storyId === "number") ctx.storyId = data.storyId;
    if (typeof data.frameId === "number") ctx.frameId = data.frameId;
    if (typeof data.styleName === "string") ctx.styleName = data.styleName;
  }
  if (code) ctx.code = code;

  // 1. Rollback — replace_paragraphs / replace_contact_block / theme_chapter.
  if (data && data.rolledBack === true) {
    const mismatch = typeof data.mismatch === "string" ? data.mismatch
      : (data.mismatch && typeof data.mismatch === "object") ? JSON.stringify(data.mismatch).slice(0, 200)
      : "rolled back";
    return {
      signal: "rollback",
      mistake: `${tool}: rolled back (${mismatch})`,
      fix: mismatch.includes("overset") ? "run continue_story immediately, or pass allowOverset:true only when a thread is prepared" : undefined,
      context: ctx,
    };
  }

  // 2. Overset detected without rollback.
  if (data && (data.overflows === true || data.overset === true)) {
    return {
      signal: "overset",
      mistake: `${tool}: produced overset text`,
      fix: "widen/extend the frame, or thread with continue_story before replacing",
      context: ctx,
    };
  }

  // 3. Explicit mismatch field.
  if (data && typeof data.mismatch === "string" && data.mismatch.trim()) {
    return {
      signal: "mismatch",
      mistake: `${tool}: ${data.mismatch}`,
      context: ctx,
    };
  }

  // 4. Error wrapper (ok:false / success:false) on a mutating tool.
  const failed = result.ok === false || result.success === false || result.error === true;
  if (failed && MUTATING_TOOL_HINTS.has(tool)) {
    const msg = typeof result.error === "string" ? result.error
      : typeof result.message === "string" ? result.message
      : "failed";
    return {
      signal: "error",
      mistake: `${tool}: ${msg}`,
      context: ctx,
    };
  }

  return null;
}

/** User called `undo`: the previous mutating step was wrong. */
function diagnoseUndo(result: Record<string, unknown>): { mistake: string; context: LessonContext } | null {
  const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : result;
  if (data.undone !== true) return null;
  const name = typeof data.undoneName === "string" ? data.undoneName : "last step";
  return { mistake: `user undid step: ${name}`, context: { code: "USER_UNDO" } };
}

/**
 * Hook invoked after every tool handler returns (success or failure).
 * Never throws — observation is best-effort.
 */
export function observe(tool: string, handlerResult: unknown): void {
  try {
    const obj = toObject(handlerResult);
    if (!obj) return;

    if (tool === "undo") {
      const u = diagnoseUndo(obj);
      if (u) recordLesson({ tool, signal: "undo", mistake: u.mistake, context: u.context });
      return;
    }

    const d = diagnose(tool, obj);
    if (d) recordLesson({ tool, signal: d.signal, mistake: d.mistake, fix: d.fix, context: d.context });
  } catch {
    /* swallow — observation must never break a tool call */
  }
}

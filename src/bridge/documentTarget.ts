import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which open document a tool call is meant to act on (ported from
 * refs/nutriandrea/src/bridge/documentTarget.ts).
 *
 * The value is a full path (preferred), a file name, or a 0-based index into
 * `app.documents`. It travels to InDesign as the injected `__TARGET_DOCUMENT_ID`
 * global that `__resolveDocument()` reads, so every script a tool call runs
 * lands on the same document — including tool modules that never look at
 * `document_id` themselves.
 *
 * AsyncLocalStorage rather than a field on the bridge: a handler can await
 * between entering and calling runScript(), and a plain field would let a
 * concurrent request overwrite the target in that window.
 */
export type DocumentTarget = string | number | null;

const storage = new AsyncLocalStorage<DocumentTarget>();

/**
 * Coerces raw tool input into a target. Anything that is not a non-negative
 * integer or a non-empty string is "no target" (the front document).
 * Numeric strings stay strings; `__findDocument` treats /^\d+$/ as an index.
 */
export function normalizeDocumentTarget(value: unknown): DocumentTarget {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/** Runs `fn` with `target` bound to every script executed inside it. */
export function withDocumentTarget<T>(target: DocumentTarget, fn: () => T): T {
  return storage.run(target, fn);
}

/** The target bound to the current call, or null for the front document. */
export function getDocumentTarget(): DocumentTarget {
  return storage.getStore() ?? null;
}

/**
 * For tool handlers that read `args.document_id` directly: the normalized
 * target, or `undefined` when absent so the bridge falls back to the
 * AsyncLocalStorage target (never an explicit null that would override it).
 */
export function targetFromArgs(args: Record<string, unknown>): string | number | undefined {
  const t = normalizeDocumentTarget(args.document_id);
  return t === null ? undefined : t;
}

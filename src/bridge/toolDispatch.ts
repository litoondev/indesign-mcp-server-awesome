import { normalizeDocumentTarget, withDocumentTarget } from "./documentTarget.js";

/**
 * Central tool plumbing shared by src/index.ts (MCP server) and test
 * harnesses: document_id schema injection, per-call document targeting via
 * AsyncLocalStorage, and failure -> isError mapping.
 */

export interface ToolDef {
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const DOCUMENT_ID_SCHEMA = {
  type: ["string", "integer"],
  description:
    "Target document: full path (preferred), file name, or 0-based index of the open document. Omit for the front document.",
};

/** Tools that act on the application or on files, not on an open document. */
const NO_DOCUMENT_ID = new Set(["probe_indesign", "open_document", "create_document", "list_open_documents", "list_pdf_presets"]);

/** Returns a copy of the schema with `document_id` present (string or integer). */
export function withDocumentIdSchema(name: string, schema: ToolDef["inputSchema"]): ToolDef["inputSchema"] {
  if (NO_DOCUMENT_ID.has(name)) return schema;
  const properties = { ...(schema.properties ?? {}) };
  const existing = properties.document_id as Record<string, unknown> | undefined;
  properties.document_id = existing ? { ...existing, type: DOCUMENT_ID_SCHEMA.type, description: DOCUMENT_ID_SCHEMA.description } : DOCUMENT_ID_SCHEMA;
  return { ...schema, properties };
}

function errorResult(error: string, code?: string, extra?: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error, ...(code ? { code } : {}), ...(extra ?? {}) }) }],
    isError: true,
  };
}

/**
 * Diagnostic payload a failed result carries to the caller: `data` (e.g.
 * continue_story's data.blocker / mismatch / rowBreak, the rollback reports of
 * replace_paragraphs / replace_contact_block) and `raw` (unparseable script
 * output). Dropping them leaves the caller with an error text that points at
 * data it never receives.
 */
function failureExtra(o: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (o.data !== undefined) extra.data = o.data;
  if (typeof o.raw === "string") extra.raw = o.raw;
  return Object.keys(extra).length ? extra : undefined;
}

function codeOf(o: Record<string, unknown>): string | undefined {
  return typeof o.code === "string" ? o.code : undefined;
}

/** Maps whatever a handler returned to an MCP result (failures -> isError, diagnostic data kept). */
export function formatToolResult(result: unknown): McpToolResult {
  let r: unknown = result;
  if (typeof r === "string") {
    const t = r.trim();
    if (t.startsWith("{")) {
      let o: unknown;
      try {
        o = JSON.parse(t);
      } catch {
        o = undefined; /* plain string */
      }
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const so = o as Record<string, unknown>;
        if (so.error === true) return errorResult(String(so.message ?? "failed"), codeOf(so), failureExtra(so));
        if (so.ok === false || so.success === false) {
          return errorResult(String(so.error ?? so.message ?? "failed"), codeOf(so), failureExtra(so));
        }
      }
    }
    return { content: [{ type: "text", text: r as string }] };
  }
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    if (o.success === false || o.ok === false) {
      return errorResult(String(o.error ?? o.message ?? "failed"), codeOf(o), failureExtra(o));
    }
    if (o.error === true) return errorResult(String(o.message ?? "failed"), codeOf(o), failureExtra(o));
    const data = "success" in o ? (o.data ?? o) : o;
    if (data && typeof data === "object" && (data as Record<string, unknown>).error === true) {
      const d = data as Record<string, unknown>;
      return errorResult(String(d.message ?? "failed"), codeOf(d), failureExtra(d));
    }
    r = data;
  }
  return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r ?? null) }] };
}

/** Runs a tool with document_id bound for every script it executes. */
export async function invokeTool(tool: ToolDef, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const target = normalizeDocumentTarget(args.document_id);
    const result = await withDocumentTarget(target, () => tool.handler(args));
    return formatToolResult(result);
  } catch (error) {
    return errorResult(
      error instanceof Error ? error.message : String(error),
      (error as { code?: string })?.code
    );
  }
}

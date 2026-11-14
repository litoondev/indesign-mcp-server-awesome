import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Review session state — persistent audit trail for a resolve-comments loop.
 *
 * Why this exists: a Review loop is a sequence of discrete tool calls with
 * user approval between them (per ADR-0001 and .claude/skills/review-loop.md).
 * The loop needs memory that outlives one assistant turn so that:
 *   • a conversation restart can resume mid-loop;
 *   • a resolved comment is never double-processed;
 *   • there is a reviewable record of which reply was sent to which comment.
 *
 * Storage: one JSON file per session under INDESIGN_MCP_REVIEW_DIR (default
 * test_output/review_sessions/). Writes go through fs.writeFile with
 * explicit absolute paths; nothing escapes the configured dir.
 *
 * Tools:
 *   review_session_begin             — start a session, return sessionId
 *   review_session_register_comments — vision records the capture's comments
 *   review_session_update            — mark comment status / notes
 *   review_session_get               — read the current state
 *   review_session_list              — list sessions (active + historical)
 *   review_session_end               — close the session; summary returned
 */

export type CommentStatus =
  | "pending"
  | "editing"
  | "edited"
  | "saved"
  | "replied"
  | "resolved"
  | "skipped"
  | "deferred";

export interface Coord {
  x: number;
  y: number;
}

export interface CommentRecord {
  ordinal: number;
  text: string;
  author?: string;
  spreadHint?: string;
  anchorCoord?: Coord;
  replyCoord?: Coord;
  resolveCoord?: Coord;
  status: CommentStatus;
  editSummary?: string;
  replyText?: string;
  resolvedAt?: string;
  notes: string[];
}

export interface CaptureRecord {
  capturedAt: string;
  outPath: string;
  windowBounds?: { left: number; top: number; width: number; height: number };
  commentCount: number;
}

export interface SessionState {
  sessionId: string;
  documentPath?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "closed";
  captures: CaptureRecord[];
  comments: CommentRecord[];
  log: Array<{ at: string; event: string; detail?: Record<string, unknown> }>;
}

function sessionsDir(): string {
  if (process.env.INDESIGN_MCP_REVIEW_DIR) return path.resolve(process.env.INDESIGN_MCP_REVIEW_DIR);
  // Project-relative default. src/domains/review/session.ts → dist/.../session.js → go up to project root.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
  const root = path.resolve(here, "..", "..", "..");
  return path.join(root, "test_output", "review_sessions");
}

function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

async function readSession(sessionId: string): Promise<SessionState> {
  const p = sessionPath(sessionId);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as SessionState;
}

async function writeSession(state: SessionState): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(sessionPath(state.sessionId), JSON.stringify(state, null, 2), "utf8");
}

function nowIso(): string {
  return new Date().toISOString();
}

function newSessionId(label?: string): string {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const slug = (label ?? "review").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "review";
  return `rv_${stamp}_${slug}`;
}

export function registerReviewSessionTools() {
  return {
    review_session_begin: {
      description:
        "Start a review session. Returns the sessionId plus the storage path. Call once at the start of a resolve-comments loop; pass the returned sessionId to every other review_session_* call. Does not interact with InDesign.",
      inputSchema: {
        type: "object" as const,
        properties: {
          documentPath: { type: "string", description: "Absolute path of the document being reviewed (for audit). Optional but recommended." },
          label: { type: "string", description: "Short slug appended to sessionId for readability (default 'review')." },
          notes: { type: "string", description: "Free-text note about why this session was started." },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const sessionId = newSessionId(typeof args.label === "string" ? args.label : undefined);
        const state: SessionState = {
          sessionId,
          documentPath: typeof args.documentPath === "string" ? args.documentPath : undefined,
          startedAt: nowIso(),
          status: "active",
          captures: [],
          comments: [],
          log: [{ at: nowIso(), event: "begin", detail: typeof args.notes === "string" ? { notes: args.notes } : undefined }],
        };
        await writeSession(state);
        return { sessionId, path: sessionPath(sessionId), storageDir: sessionsDir() };
      },
    },

    review_session_register_comments: {
      description:
        "Record what a capture revealed. Vision names the comments it read from the latest review_capture_panel PNG; each comment gets an ordinal (1-based, top to bottom) plus optional coordinates for its reply trigger and resolve control. Overwrites the current comment list; status defaults to 'pending' unless a comment with the same ordinal exists with another status, which is preserved.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
          capture: {
            type: "object",
            description: "The capture these comments came from.",
            properties: {
              outPath: { type: "string" },
              windowBounds: {
                type: "object",
                properties: { left: { type: "integer" }, top: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } },
              },
            },
            required: ["outPath"],
          },
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ordinal: { type: "integer", minimum: 1 },
                text: { type: "string" },
                author: { type: "string" },
                spreadHint: { type: "string" },
                anchorCoord: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } } },
                replyCoord: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } } },
                resolveCoord: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } } },
              },
              required: ["ordinal", "text"],
            },
          },
        },
        required: ["sessionId", "capture", "comments"],
      },
      handler: async (args: Record<string, unknown>) => {
        const state = await readSession(String(args.sessionId));
        if (state.status === "closed") throw new Error(`session ${state.sessionId} is closed`);
        const capture = args.capture as { outPath: string; windowBounds?: CaptureRecord["windowBounds"] };
        const commentsIn = args.comments as Array<Partial<CommentRecord>>;
        const prior = new Map(state.comments.map((c) => [c.ordinal, c]));
        state.comments = commentsIn.map((c) => {
          const existing = prior.get(c.ordinal ?? -1);
          return {
            ordinal: c.ordinal!,
            text: String(c.text ?? ""),
            author: c.author,
            spreadHint: c.spreadHint,
            anchorCoord: c.anchorCoord,
            replyCoord: c.replyCoord,
            resolveCoord: c.resolveCoord,
            status: existing?.status && existing.status !== "pending" ? existing.status : "pending",
            editSummary: existing?.editSummary,
            replyText: existing?.replyText,
            resolvedAt: existing?.resolvedAt,
            notes: existing?.notes ?? [],
          };
        });
        state.captures.push({
          capturedAt: nowIso(),
          outPath: capture.outPath,
          windowBounds: capture.windowBounds,
          commentCount: state.comments.length,
        });
        state.log.push({ at: nowIso(), event: "register_comments", detail: { count: state.comments.length } });
        await writeSession(state);
        return { sessionId: state.sessionId, comments: state.comments };
      },
    },

    review_session_update: {
      description:
        "Advance a comment through its lifecycle. Status transitions: pending → editing → edited → saved → replied → resolved (or skipped/deferred at any point). editSummary / replyText / note are recorded when provided.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
          ordinal: { type: "integer", minimum: 1 },
          status: { type: "string", enum: ["pending", "editing", "edited", "saved", "replied", "resolved", "skipped", "deferred"] },
          editSummary: { type: "string", description: "Short description of what was fixed in the document." },
          replyText: { type: "string", description: "The text sent as the reply (for audit)." },
          note: { type: "string", description: "Free-text note appended to the comment's notes list." },
        },
        required: ["sessionId", "ordinal"],
      },
      handler: async (args: Record<string, unknown>) => {
        const state = await readSession(String(args.sessionId));
        if (state.status === "closed") throw new Error(`session ${state.sessionId} is closed`);
        const ordinal = Number(args.ordinal);
        const c = state.comments.find((x) => x.ordinal === ordinal);
        if (!c) throw new Error(`comment #${ordinal} not found in session ${state.sessionId}`);
        if (typeof args.status === "string") c.status = args.status as CommentStatus;
        if (typeof args.editSummary === "string") c.editSummary = args.editSummary;
        if (typeof args.replyText === "string") c.replyText = args.replyText;
        if (typeof args.note === "string") c.notes.push(args.note);
        if (c.status === "resolved" && !c.resolvedAt) c.resolvedAt = nowIso();
        state.log.push({ at: nowIso(), event: "update", detail: { ordinal, status: c.status } });
        await writeSession(state);
        return { comment: c };
      },
    },

    review_session_get: {
      description: "Return the full session state (captures, comments, log).",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
          summaryOnly: { type: "boolean", description: "If true, omit the log and per-comment notes for a compact response." },
        },
        required: ["sessionId"],
      },
      handler: async (args: Record<string, unknown>) => {
        const state = await readSession(String(args.sessionId));
        if (args.summaryOnly) {
          const counts = state.comments.reduce<Record<string, number>>((acc, c) => {
            acc[c.status] = (acc[c.status] ?? 0) + 1;
            return acc;
          }, {});
          return {
            sessionId: state.sessionId,
            documentPath: state.documentPath,
            startedAt: state.startedAt,
            status: state.status,
            commentCount: state.comments.length,
            statusCounts: counts,
            captures: state.captures.length,
          };
        }
        return state;
      },
    },

    review_session_list: {
      description: "List review sessions on disk (newest first). Shows status, comment count, document path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          activeOnly: { type: "boolean", description: "If true, show only sessions still open." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Max rows to return (default 25)." },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const dir = sessionsDir();
        let names: string[] = [];
        try {
          names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
        } catch {
          return { storageDir: dir, sessions: [] };
        }
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.round(args.limit))) : 25;
        const rows = await Promise.all(
          names.map(async (n) => {
            try {
              const s = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as SessionState;
              return {
                sessionId: s.sessionId,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                status: s.status,
                documentPath: s.documentPath,
                comments: s.comments.length,
                resolved: s.comments.filter((c) => c.status === "resolved").length,
              };
            } catch {
              return null;
            }
          }),
        );
        const cleaned = rows.filter((r): r is NonNullable<typeof r> => r !== null);
        cleaned.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
        const filtered = args.activeOnly ? cleaned.filter((r) => r.status === "active") : cleaned;
        return { storageDir: dir, sessions: filtered.slice(0, limit) };
      },
    },

    review_session_end: {
      description: "Close the session. Returns a final summary (per-status counts, list of resolved comments with their replies).",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
          note: { type: "string", description: "Closing note for the audit log." },
        },
        required: ["sessionId"],
      },
      handler: async (args: Record<string, unknown>) => {
        const state = await readSession(String(args.sessionId));
        if (state.status === "closed") return { sessionId: state.sessionId, alreadyClosed: true };
        state.status = "closed";
        state.endedAt = nowIso();
        state.log.push({ at: nowIso(), event: "end", detail: typeof args.note === "string" ? { note: args.note } : undefined });
        await writeSession(state);
        const counts = state.comments.reduce<Record<string, number>>((acc, c) => {
          acc[c.status] = (acc[c.status] ?? 0) + 1;
          return acc;
        }, {});
        return {
          sessionId: state.sessionId,
          status: state.status,
          endedAt: state.endedAt,
          statusCounts: counts,
          resolved: state.comments.filter((c) => c.status === "resolved").map((c) => ({ ordinal: c.ordinal, text: c.text, replyText: c.replyText, editSummary: c.editSummary })),
          path: sessionPath(state.sessionId),
        };
      },
    },
  };
}

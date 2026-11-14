import {
  consultLessons,
  createSet,
  deleteSet,
  forgetLesson,
  getActive,
  getRoot,
  listSets,
  readSet,
  recordLesson,
  setActive,
  type LessonSignal,
} from "../memory/store.js";

/**
 * MCP tools over the auto-learning memory store. Observation is done
 * automatically from invokeTool; these tools let the caller name a set, read
 * what has been learned, consult lessons before an action, and prune bad
 * entries.
 */

const SIGNALS = ["overset", "mismatch", "rollback", "undo", "error", "user"] as const;

function assertSignal(v: unknown, label: string): LessonSignal | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !(SIGNALS as readonly string[]).includes(v)) {
    throw new Error(`${label} must be one of ${SIGNALS.join(", ")}`);
  }
  return v as LessonSignal;
}

export function registerMemoryTools() {
  return {
    memory_status: {
      description:
        "Report the auto-learning memory state: the memory root folder, the active set name, every set with its lesson count, and the total number of lessons the plugin has recorded.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async () => {
        const sets = listSets();
        return {
          root: getRoot(),
          active: getActive(),
          sets,
          totalLessons: sets.reduce((n, s) => n + s.lessons, 0),
        };
      },
    },

    memory_create: {
      description:
        "Create a named memory set (if it does not exist) and make it the active set. The set stores lessons the plugin auto-captures from mistakes (rollbacks, oversets, mismatches, errors on mutating tools, user undo).",
      inputSchema: {
        type: "object" as const,
        properties: { name: { type: "string", description: "Set name (letters, digits, '.', '_', '-'; max 64)" } },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name is required");
        const set = createSet(args.name.trim());
        setActive(set.name);
        return { created: true, active: set.name, lessons: set.lessons.length };
      },
    },

    memory_use: {
      description: "Switch the active memory set. Observations and consults default to the active set.",
      inputSchema: {
        type: "object" as const,
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name is required");
        createSet(args.name.trim()); // ensures exists
        setActive(args.name.trim());
        return { active: args.name.trim() };
      },
    },

    memory_list: {
      description: "List every named memory set with lesson count and last-updated timestamp.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async () => ({ active: getActive(), sets: listSets() }),
    },

    memory_get: {
      description:
        "Read lessons from a memory set (default: active). Filter by tool, signal (overset|mismatch|rollback|undo|error|user), minHits, or limit. Returns lessons ordered by recurrence (hits) then recency.",
      inputSchema: {
        type: "object" as const,
        properties: {
          setName: { type: "string", description: "Memory set to read (default: active)" },
          tool: { type: "string", description: "Only lessons for this tool name" },
          signal: { type: "string", enum: [...SIGNALS] as string[] },
          styleName: { type: "string" },
          doc: { type: "string", description: "Document path or file name" },
          minHits: { type: "number", description: "Only lessons seen at least this many times. Default: 1" },
          limit: { type: "number", description: "Default: 20, max 200" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const lessons = consultLessons({
          tool: typeof args.tool === "string" ? args.tool : undefined,
          signal: assertSignal(args.signal, "signal"),
          doc: typeof args.doc === "string" ? args.doc : undefined,
          styleName: typeof args.styleName === "string" ? args.styleName : undefined,
          minHits: typeof args.minHits === "number" ? args.minHits : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          setName: typeof args.setName === "string" ? args.setName : undefined,
        });
        return { setName: typeof args.setName === "string" ? args.setName : getActive(), count: lessons.length, lessons };
      },
    },

    memory_consult: {
      description:
        "Consult lessons relevant to an upcoming action: pass the tool you are about to call (plus optional doc / styleName) and get back the most-recurring lessons recorded against that tool. Use this before mutating actions to avoid repeating a mistake.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tool: { type: "string", description: "Tool you are about to call" },
          doc: { type: "string" },
          styleName: { type: "string" },
          limit: { type: "number", description: "Default: 10" },
          setName: { type: "string" },
        },
        required: ["tool"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.tool !== "string" || !args.tool.trim()) throw new Error("tool is required");
        const lessons = consultLessons({
          tool: args.tool,
          doc: typeof args.doc === "string" ? args.doc : undefined,
          styleName: typeof args.styleName === "string" ? args.styleName : undefined,
          limit: typeof args.limit === "number" ? args.limit : 10,
          setName: typeof args.setName === "string" ? args.setName : undefined,
        });
        return { tool: args.tool, count: lessons.length, lessons };
      },
    },

    memory_record: {
      description:
        "Explicitly record a lesson (e.g. the user said 'that was wrong because X'). Auto-observation already captures rollbacks, oversets, mismatches, errors and undo; use this only for lessons the plugin cannot infer from tool output.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tool: { type: "string", description: "Tool the lesson applies to (e.g. 'replace_paragraphs')" },
          signal: { type: "string", enum: [...SIGNALS] as string[], description: "Default: user" },
          mistake: { type: "string", description: "What went wrong (one short sentence)" },
          fix: { type: "string", description: "Correct approach (optional)" },
          context: {
            type: "object",
            properties: {
              doc: { type: "string" },
              page: { type: ["number", "string"] },
              styleName: { type: "string" },
            },
          },
          setName: { type: "string" },
        },
        required: ["tool", "mistake"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.tool !== "string" || !args.tool.trim()) throw new Error("tool is required");
        if (typeof args.mistake !== "string" || !args.mistake.trim()) throw new Error("mistake is required");
        const signal = assertSignal(args.signal, "signal") ?? "user";
        const res = recordLesson({
          tool: args.tool.trim(),
          signal,
          mistake: args.mistake.trim(),
          fix: typeof args.fix === "string" && args.fix.trim() ? args.fix.trim() : undefined,
          context: args.context && typeof args.context === "object" ? (args.context as Record<string, unknown>) : {},
          setName: typeof args.setName === "string" ? args.setName : undefined,
        });
        return res;
      },
    },

    memory_forget: {
      description: "Delete one lesson by id or signature from a memory set (default: active).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Lesson id ('lsn_…') or signature" },
          setName: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.id !== "string" || !args.id.trim()) throw new Error("id is required");
        const removed = forgetLesson(args.id.trim(), typeof args.setName === "string" ? args.setName : undefined);
        return { removed };
      },
    },

    memory_delete_set: {
      description: "Delete a memory set entirely. Refuses to delete the active set — switch first with memory_use.",
      inputSchema: {
        type: "object" as const,
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name is required");
        const name = args.name.trim();
        if (name === getActive()) throw new Error(`refusing to delete the active set '${name}'; switch with memory_use first`);
        return { deleted: deleteSet(name) };
      },
    },

    memory_summary: {
      description: "Summary of lessons in a set (default: active) grouped by tool and signal, with total hits.",
      inputSchema: {
        type: "object" as const,
        properties: { setName: { type: "string" } },
      },
      handler: async (args: Record<string, unknown>) => {
        const name = typeof args.setName === "string" && args.setName.trim() ? args.setName.trim() : getActive();
        const set = readSet(name);
        const byTool = new Map<string, { lessons: number; hits: number }>();
        const bySignal = new Map<string, { lessons: number; hits: number }>();
        for (const l of set.lessons) {
          const t = byTool.get(l.tool) ?? { lessons: 0, hits: 0 };
          t.lessons += 1; t.hits += l.hits; byTool.set(l.tool, t);
          const s = bySignal.get(l.signal) ?? { lessons: 0, hits: 0 };
          s.lessons += 1; s.hits += l.hits; bySignal.set(l.signal, s);
        }
        return {
          setName: name,
          lessons: set.lessons.length,
          totalHits: set.lessons.reduce((n, l) => n + l.hits, 0),
          byTool: Object.fromEntries(byTool),
          bySignal: Object.fromEntries(bySignal),
        };
      },
    },
  };
}

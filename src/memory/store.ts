import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * Persistent, per-set memory of what went wrong (and how it was fixed) while
 * driving InDesign. Lessons are deduplicated by a signature over
 * {tool, signal, keyFields}: the second time the same pattern happens, `hits`
 * increments and `lastSeen` updates in place so the file does not grow linearly.
 *
 * Storage: one JSON file per set under `I:\Indesign\memory\<set>.json`. Writes
 * are atomic (tmp + rename) so a crash during write cannot corrupt the file.
 */

export interface LessonContext {
  doc?: string;
  page?: number | string;
  storyId?: number;
  frameId?: number;
  styleName?: string;
  code?: string;
  [k: string]: unknown;
}

export type LessonSignal = "overset" | "mismatch" | "rollback" | "undo" | "error" | "user";

export interface Lesson {
  id: string;
  signature: string;
  tool: string;
  signal: LessonSignal;
  mistake: string;
  fix?: string;
  context: LessonContext;
  hits: number;
  created: string;
  lastSeen: string;
}

export interface MemorySet {
  name: string;
  created: string;
  updated: string;
  lessons: Lesson[];
}

const ROOT = (() => {
  const envRoot = process.env.INDESIGN_MCP_MEMORY_ROOT;
  if (envRoot && envRoot.trim()) return path.resolve(envRoot.trim());
  return path.resolve(process.cwd(), "memory");
})();

const ACTIVE_FILE = path.join(ROOT, ".active");
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function ensureRoot(): void {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
}

function setPath(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid memory set name '${name}' (letters, digits, '.', '_', '-' only)`);
  return path.join(ROOT, `${name}.json`);
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, "utf8");
  // On Windows rename over an existing file is atomic only via fs.renameSync when target doesn't exist.
  // Fall back to replace: remove target first if present.
  if (existsSync(file)) {
    try { unlinkSync(file); } catch {}
  }
  writeFileSync(file, readFileSync(tmp, "utf8"), "utf8");
  try { unlinkSync(tmp); } catch {}
}

export function listSets(): { name: string; lessons: number; updated: string }[] {
  ensureRoot();
  const files = readdirSync(ROOT).filter((f) => f.endsWith(".json"));
  const out: { name: string; lessons: number; updated: string }[] = [];
  for (const f of files) {
    const name = f.slice(0, -5);
    try {
      const s = JSON.parse(readFileSync(path.join(ROOT, f), "utf8")) as MemorySet;
      out.push({ name, lessons: s.lessons?.length ?? 0, updated: s.updated });
    } catch {
      out.push({ name, lessons: 0, updated: "" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSet(name: string): MemorySet {
  ensureRoot();
  const p = setPath(name);
  if (!existsSync(p)) {
    const now = new Date().toISOString();
    return { name, created: now, updated: now, lessons: [] };
  }
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Partial<MemorySet>;
  return {
    name,
    created: parsed.created ?? new Date().toISOString(),
    updated: parsed.updated ?? new Date().toISOString(),
    lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
  };
}

export function writeSet(set: MemorySet): void {
  ensureRoot();
  set.updated = new Date().toISOString();
  atomicWrite(setPath(set.name), JSON.stringify(set, null, 2));
}

export function createSet(name: string): MemorySet {
  ensureRoot();
  const p = setPath(name);
  if (existsSync(p)) return readSet(name);
  const now = new Date().toISOString();
  const s: MemorySet = { name, created: now, updated: now, lessons: [] };
  writeSet(s);
  return s;
}

export function deleteSet(name: string): boolean {
  const p = setPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function getActive(): string {
  ensureRoot();
  if (!existsSync(ACTIVE_FILE)) return "default";
  const n = readFileSync(ACTIVE_FILE, "utf8").trim();
  return SAFE_NAME.test(n) ? n : "default";
}

export function setActive(name: string): void {
  ensureRoot();
  if (!SAFE_NAME.test(name)) throw new Error(`invalid memory set name '${name}'`);
  atomicWrite(ACTIVE_FILE, name);
}

/** Stable signature for deduplication: same tool+signal+key context => one lesson row. */
export function signatureOf(tool: string, signal: LessonSignal, mistake: string, ctx: LessonContext): string {
  const key = {
    tool,
    signal,
    // Use a trimmed mistake string so near-duplicates collapse.
    mistake: mistake.replace(/\s+/g, " ").trim().slice(0, 160).toLowerCase(),
    doc: ctx.doc ?? "",
    page: ctx.page ?? "",
    style: ctx.styleName ?? "",
    code: ctx.code ?? "",
  };
  return createHash("sha1").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}

/**
 * Record one observation into the active (or named) set. Returns the lesson
 * that now carries the new hit — new or merged — so the caller can report it.
 */
export function recordLesson(input: {
  tool: string;
  signal: LessonSignal;
  mistake: string;
  fix?: string;
  context?: LessonContext;
  setName?: string;
}): { lesson: Lesson; created: boolean; setName: string } {
  const setName = input.setName && SAFE_NAME.test(input.setName) ? input.setName : getActive();
  const set = readSet(setName);
  const ctx = input.context ?? {};
  const sig = signatureOf(input.tool, input.signal, input.mistake, ctx);
  const now = new Date().toISOString();
  const existing = set.lessons.find((l) => l.signature === sig);
  if (existing) {
    existing.hits += 1;
    existing.lastSeen = now;
    if (input.fix && !existing.fix) existing.fix = input.fix;
    writeSet(set);
    return { lesson: existing, created: false, setName };
  }
  const lesson: Lesson = {
    id: "lsn_" + randomBytes(5).toString("hex"),
    signature: sig,
    tool: input.tool,
    signal: input.signal,
    mistake: input.mistake,
    fix: input.fix,
    context: ctx,
    hits: 1,
    created: now,
    lastSeen: now,
  };
  set.lessons.push(lesson);
  writeSet(set);
  return { lesson, created: true, setName };
}

export function forgetLesson(idOrSignature: string, setName?: string): boolean {
  const name = setName && SAFE_NAME.test(setName) ? setName : getActive();
  const set = readSet(name);
  const before = set.lessons.length;
  set.lessons = set.lessons.filter((l) => l.id !== idOrSignature && l.signature !== idOrSignature);
  if (set.lessons.length === before) return false;
  writeSet(set);
  return true;
}

/** Consult the active set for lessons relevant to an upcoming action. */
export function consultLessons(filter: {
  tool?: string;
  signal?: LessonSignal;
  doc?: string;
  styleName?: string;
  minHits?: number;
  limit?: number;
  setName?: string;
}): Lesson[] {
  const name = filter.setName && SAFE_NAME.test(filter.setName) ? filter.setName : getActive();
  const set = readSet(name);
  const min = filter.minHits ?? 1;
  const limit = Math.max(1, Math.min(200, filter.limit ?? 20));
  const docBase = filter.doc ? path.basename(filter.doc).toLowerCase() : "";
  const scored = set.lessons
    .filter((l) => (filter.tool ? l.tool === filter.tool : true))
    .filter((l) => (filter.signal ? l.signal === filter.signal : true))
    .filter((l) => (filter.styleName ? (l.context.styleName ?? "") === filter.styleName : true))
    .filter((l) => {
      if (!docBase) return true;
      const ld = typeof l.context.doc === "string" ? path.basename(l.context.doc).toLowerCase() : "";
      return !ld || ld === docBase;
    })
    .filter((l) => l.hits >= min)
    .sort((a, b) => b.hits - a.hits || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
  return scored;
}

export function getRoot(): string {
  return ROOT;
}

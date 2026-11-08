import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { platform } from "node:os";

/**
 * Write-safety guard. The MCP server may only create or overwrite InDesign
 * documents (and export/package output) under the configured write roots, and
 * never the pristine test master, and never under a "Downloads" folder unless
 * that folder (or one inside it) is an explicit root. This is the ONE write
 * policy: tools/batchB_writePolicy re-exports it and the in-script guard
 * (__mcpIsWritablePath / __mcpAssertWritable) mirrors it.
 *
 * Roots come from INDESIGN_MCP_WRITE_ROOTS (separated by ';'), defaulting to
 * the review workflow's run folders. Set the variable to point at your real
 * working folders when using the server for production work.
 */

const IS_WIN = platform() === "win32";
const P = IS_WIN ? path.win32 : path.posix;

export const DEFAULT_WRITE_ROOTS = "I:\\Indesign\\test_fixtures\\runs;I:\\Indesign\\test_output";
export const PROTECTED_BASENAMES = ["brac_test_master.indd"];

export class SafetyError extends Error {
  readonly code = "SAFETY";
  constructor(message: string) {
    super(message.startsWith("SAFETY") ? message : `SAFETY: ${message}`);
    this.name = "SafetyError";
  }
}

/** Resolves symlinks/junctions for the deepest existing ancestor of `p`. */
function realish(p: string): string {
  let cur = P.resolve(p);
  const rest: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      try {
        cur = realpathSync.native(cur);
      } catch {
        /* keep resolved path */
      }
      return rest.length ? P.join(cur, ...rest.reverse()) : cur;
    }
    const parent = P.dirname(cur);
    if (parent === cur) return P.resolve(p);
    rest.push(P.basename(cur));
    cur = parent;
  }
}

/** Comparison key: absolute, real, '/'-separated, lower-cased, no trailing '/'. */
export function normalizeForCompare(p: string): string {
  return realish(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function getWriteRoots(): string[] {
  const raw = process.env.INDESIGN_MCP_WRITE_ROOTS ?? DEFAULT_WRITE_ROOTS;
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => P.resolve(s));
}

function rootKeys(): string[] {
  return getWriteRoots().map(normalizeForCompare);
}

export function isProtectedBasename(p: string): boolean {
  const base = p.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return PROTECTED_BASENAMES.includes(base);
}

function under(key: string, rootKey: string): boolean {
  return key === rootKey || key.startsWith(rootKey + "/");
}

// -- Downloads rule ---------------------------------------------------------
// The one extra rule of the write policy: a path under a "Downloads" folder is
// refused unless a root listed explicitly in INDESIGN_MCP_WRITE_ROOTS is that
// Downloads folder or a folder inside it. A broad root (e.g. the user profile)
// therefore never opens Downloads. The default roots never include Downloads.

/** Normalised key of the first ".../downloads" ancestor of `key` (itself included), or null. */
export function downloadsAncestor(key: string): string | null {
  const parts = key.split("/");
  const i = parts.indexOf("downloads");
  return i < 0 ? null : parts.slice(0, i + 1).join("/");
}

/** Roots listed explicitly in INDESIGN_MCP_WRITE_ROOTS (empty when the variable is unset). */
export function explicitRootKeys(): string[] {
  const raw = process.env.INDESIGN_MCP_WRITE_ROOTS;
  if (!raw || !raw.trim()) return [];
  return getWriteRoots().map(normalizeForCompare);
}

/**
 * Returns the reason `p` may not be written because it is under a Downloads
 * folder, or null when the Downloads rule does not block it.
 */
export function downloadsBlockReason(p: string): string | null {
  const key = normalizeForCompare(p);
  const dl = downloadsAncestor(key);
  if (!dl) return null;
  if (explicitRootKeys().some((r) => under(r, dl) && under(key, r))) return null;
  return (
    `refusing to write under a Downloads folder (${p}). ` +
    `List that Downloads folder (or a folder inside it) explicitly in INDESIGN_MCP_WRITE_ROOTS to allow it.`
  );
}

/**
 * The single write-path policy: inside a write root AND not blocked by the
 * Downloads rule. Used by assertSafeWritePath / assertSafeWriteDir and every
 * tool-level check (tools/batchB_writePolicy re-exports it).
 */
export function isUnderWriteRoots(p: string): boolean {
  const key = normalizeForCompare(p);
  if (!rootKeys().some((r) => under(key, r))) return false;
  return downloadsBlockReason(p) === null;
}

/** Alias of isUnderWriteRoots (name used by the tool layer). */
export const isWritablePath = isUnderWriteRoots;

/** Throws a SafetyError when the Downloads rule blocks `p`. */
export function assertNotBlockedDownloads(p: string): void {
  const reason = downloadsBlockReason(p);
  if (reason) throw new SafetyError(reason);
}

export interface SafeWriteOptions {
  /** Allow replacing an existing file. Default false. */
  overwrite?: boolean;
}

/**
 * Validates a file path a tool is about to write. Returns the resolved path.
 * Refuses: paths outside the write roots, the protected master basename,
 * extensions not in `allowedExts` (e.g. ['.indd']; null = any), and existing
 * files unless `overwrite` is true.
 */
export function assertSafeWritePath(
  p: unknown,
  allowedExts: string[] | null,
  opts: SafeWriteOptions = {}
): string {
  if (typeof p !== "string" || p.trim() === "") throw new SafetyError("a non-empty file path is required");
  const resolved = P.resolve(p.trim());
  if (isProtectedBasename(resolved)) {
    throw new SafetyError(`refusing to write the protected test master (${resolved}). Copy it to a run folder first.`);
  }
  if (allowedExts && allowedExts.length) {
    const ext = P.extname(resolved).toLowerCase();
    if (!allowedExts.map((e) => e.toLowerCase()).includes(ext)) {
      throw new SafetyError(`extension '${ext || "(none)"}' not allowed here; expected ${allowedExts.join(", ")}`);
    }
  }
  assertNotBlockedDownloads(resolved);
  if (!isUnderWriteRoots(resolved)) {
    throw new SafetyError(
      `path outside allowed write folders: ${resolved}. Allowed: ${getWriteRoots().join("; ")} (set INDESIGN_MCP_WRITE_ROOTS to change)`
    );
  }
  if (existsSync(resolved)) {
    let isDir = false;
    try {
      isDir = statSync(resolved).isDirectory();
    } catch {
      /* ignore */
    }
    if (isDir) throw new SafetyError(`path is a directory, expected a file: ${resolved}`);
    if (!opts.overwrite) throw new SafetyError(`file already exists: ${resolved} (pass overwrite:true to replace it)`);
  }
  return resolved;
}

/** Validates an output folder (exports, packages). Returns the resolved path. */
export function assertSafeWriteDir(p: unknown): string {
  if (typeof p !== "string" || p.trim() === "") throw new SafetyError("a non-empty folder path is required");
  const resolved = P.resolve(p.trim());
  assertNotBlockedDownloads(resolved);
  if (!isUnderWriteRoots(resolved)) {
    throw new SafetyError(
      `folder outside allowed write folders: ${resolved}. Allowed: ${getWriteRoots().join("; ")} (set INDESIGN_MCP_WRITE_ROOTS to change)`
    );
  }
  return resolved;
}

/**
 * ExtendScript array literal of normalized root keys, consumed by the in-script
 * guard `__mcpAssertWritable(doc)` (see extendScriptHelpers.ts).
 */
export function writeRootsLiteral(): string {
  // Both the real path (junctions / 8.3 short names expanded) and the path as
  // configured, because InDesign reports fsName without resolving either.
  return "[" + writeRootKeysForScript().map((r) => JSON.stringify(r)).join(",") + "]";
}

/**
 * Root keys for in-script checks: both the real path (junctions / 8.3 short
 * names expanded) and the path as configured, lower-cased, '/'-separated.
 */
function scriptKeys(roots: string[]): string[] {
  const keys = new Set<string>();
  for (const r of roots) {
    keys.add(normalizeForCompare(r));
    keys.add(r.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
  }
  return Array.from(keys);
}

/** writeRootsLiteral as an array (consumed by tool-level in-script guards). */
export function writeRootKeysForScript(): string[] {
  return scriptKeys(getWriteRoots());
}

/**
 * ExtendScript array literal of the explicit roots that lie inside a Downloads
 * folder (the only roots that may open one), consumed by __mcpIsWritablePath.
 */
export function downloadsAllowedLiteral(): string {
  const raw = process.env.INDESIGN_MCP_WRITE_ROOTS;
  const explicit = raw && raw.trim() ? getWriteRoots() : [];
  const keys = scriptKeys(explicit).filter((k) => downloadsAncestor(k) !== null);
  return "[" + keys.map((k) => JSON.stringify(k)).join(",") + "]";
}

export function protectedBasenamesLiteral(): string {
  return "[" + PROTECTED_BASENAMES.map((b) => JSON.stringify(b)).join(",") + "]";
}

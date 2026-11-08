/**
 * Shared kit for the page / export / image / table / color tools (batch C).
 *
 * Write roots and the in-script document guard come from batch A
 * (src/bridge/safety.ts, RunOptions.mutating). The literal encoders, the
 * export-path check (creates folders, refuses .indd, overwrite default true) and
 * the `__lc*` ExtendScript helpers (page<->spread coords, merge-aware cell
 * addressing, item lookup incl. grouped/anchored/master items, parity report,
 * page-spec parser, prefs save/restore) are batch C's own, under collision-proof
 * names, and are harmless next to batch A's helpers.
 *
 * Conventions every batch C script follows (via runLC):
 *   - The document comes from __resolveDocument() (document targeting).
 *   - The script runs inside an IIFE and returns __ok(data) / __fail(msg).
 *   - app.scriptPreferences.measurementUnit is forced to POINTS and
 *     userInteractionLevel to NEVER_INTERACT for the duration of the script,
 *     and both are restored in `finally` (a modal alert is a classic cause of
 *     DoScript calls that hang for 10+ minutes).
 *   - Mutating scripts refuse to touch a saved document whose file is outside
 *     the write roots, and always refuse BRAC_TEST_MASTER.indd.
 *   - Mutating scripts get an undoName so they are a single undo step.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize } from "node:path";
import type { InDesignBridge, RunOptions } from "../bridge/index.js";
import { getWriteRoots, isUnderWriteRoots } from "../bridge/safety.js";
import { downloadsBlockReason, writeRootKeysForScript } from "./batchB_writePolicy.js";
import type { ScriptResult } from "../types.js";

// ───────────────────────────── literal encoders ─────────────────────────────

// Built with fromCharCode so the source never contains raw U+2028/U+2029 (they break regex literals).
const LS_RE = new RegExp(String.fromCharCode(0x2028), "g");
const PS_RE = new RegExp(String.fromCharCode(0x2029), "g");

/** Encode any value as an ExtendScript string literal (safe against quotes, backslashes, control chars, U+2028/9). */
export function jsStr(v: unknown): string {
  if (v === undefined || v === null) throw new Error("Expected a string value, got " + String(v));
  return JSON.stringify(String(v)).replace(LS_RE, "\\u2028").replace(PS_RE, "\\u2029");
}

export interface NumOpts {
  int?: boolean;
  min?: number;
  max?: number;
}

/** Encode a number as an ExtendScript literal; throws a readable error when it is not a finite number in range. */
export function jsNum(v: unknown, name: string, opts: NumOpts = {}): string {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number (got ${JSON.stringify(v)})`);
  }
  if (opts.int && !Number.isInteger(n)) throw new Error(`${name} must be an integer (got ${n})`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${name} must be >= ${opts.min} (got ${n})`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${name} must be <= ${opts.max} (got ${n})`);
  return String(n);
}

/** Like jsNum but returns `fallback` (already a literal) when the value is null/undefined. */
export function jsOptNum(v: unknown, name: string, fallback: string, opts: NumOpts = {}): string {
  return v === undefined || v === null ? fallback : jsNum(v, name, opts);
}

export function jsBool(v: unknown, fallback: boolean): string {
  if (v === undefined || v === null) return fallback ? "true" : "false";
  if (typeof v !== "boolean") throw new Error(`Expected a boolean, got ${JSON.stringify(v)}`);
  return v ? "true" : "false";
}

export function jsNumArray(v: unknown, name: string, len?: number, opts: NumOpts = {}): string {
  if (!Array.isArray(v)) throw new Error(`${name} must be an array of numbers`);
  if (len !== undefined && v.length !== len) throw new Error(`${name} must have exactly ${len} numbers (got ${v.length})`);
  return "[" + v.map((x, i) => jsNum(x, `${name}[${i}]`, opts)).join(",") + "]";
}

/** [top, left, bottom, right] with bottom > top and right > left. */
export function jsBounds(v: unknown, name = "bounds"): string {
  const lit = jsNumArray(v, name, 4);
  const b = v as number[];
  if (!(b[2] > b[0]) || !(b[3] > b[1])) {
    throw new Error(`${name} must be [top, left, bottom, right] with bottom > top and right > left (got ${JSON.stringify(b)})`);
  }
  return lit;
}

export function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}

export function reqStr(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`${name} is required and must be a non-empty string`);
  return v;
}

// ───────────────────────────── path safety ─────────────────────────────

const MASTER_BASENAME = "brac_test_master.indd";

/**
 * Folders file writes (exports, packages) and document mutations are allowed
 * under. Single source of truth: batch A's safety module (INDESIGN_MCP_WRITE_ROOTS,
 * default test_fixtures\runs; test_output).
 */
export function writeRoots(): string[] {
  return getWriteRoots().map((r) => normalize(r));
}

function checkBasicPath(p: unknown, what: string): string {
  if (typeof p !== "string" || p.trim() === "") throw new Error(`${what} is required and must be a non-empty absolute path`);
  if (p.includes("\0")) throw new Error(`${what} contains a NUL byte`);
  if (p.split(/[\\/]+/).includes("..")) throw new Error(`${what} must not contain '..' segments: ${p}`);
  if (!isAbsolute(p)) throw new Error(`${what} must be an absolute path: ${p}`);
  return normalize(p);
}

export interface SafeWriteOpts {
  /** Allow replacing an existing file. Default true (re-exporting previews is normal). */
  overwrite?: boolean;
  /** The path is a folder (package_document / per-page image export). */
  folder?: boolean;
}

/**
 * Validate an output path in Node before any script runs. Refuses InDesign
 * documents, paths outside the write roots and the pristine test master, and
 * creates the parent folder so exportFile does not fail on a missing folder.
 * Returns the path with forward slashes for ExtendScript's File().
 */
export function assertSafeWritePath(p: unknown, exts: string[], opts: SafeWriteOpts = {}): string {
  const n = checkBasicPath(p, "outputPath");
  const lower = n.toLowerCase();
  const ext = extname(lower);
  if ([".indd", ".indt", ".idlk", ".indb"].includes(ext)) {
    throw new Error(`Refusing to write an InDesign document/template via an export tool: ${n}`);
  }
  if (lower.endsWith(MASTER_BASENAME)) throw new Error("Refusing to write over BRAC_TEST_MASTER.indd");
  if (!opts.folder && exts.length && !exts.includes(ext)) {
    throw new Error(`outputPath must end with ${exts.join(" or ")} (got '${ext || "no extension"}'): ${n}`);
  }
  if (!isUnderWriteRoots(n)) {
    throw new Error(`outputPath ${n} is outside the allowed write roots (${writeRoots().join("; ")}). Set INDESIGN_MCP_WRITE_ROOTS to change them.`);
  }
  // The one shared Downloads rule (same as save/backup/replace tools).
  const dlReason = downloadsBlockReason(n);
  if (dlReason) throw new Error(dlReason);
  if (!opts.folder && opts.overwrite === false && existsSync(n)) {
    throw new Error(`outputPath already exists and overwrite is false: ${n}`);
  }
  if (!opts.folder && existsSync(n) && statSync(n).isDirectory()) {
    throw new Error(`outputPath is an existing folder, expected a file: ${n}`);
  }
  mkdirSync(opts.folder ? n : dirname(n), { recursive: true });
  return n.replace(/\\/g, "/");
}

/** Validate an input file (image, docx, txt, xml) exists before any document mutation happens. */
export function assertReadableFile(p: unknown, exts: string[] | null, what = "filePath"): string {
  const n = checkBasicPath(p, what);
  const ext = extname(n).toLowerCase();
  if (exts && !exts.includes(ext)) throw new Error(`${what} must be one of ${exts.join(", ")} (got '${ext || "no extension"}'): ${n}`);
  if (!existsSync(n)) throw new Error(`${what} does not exist: ${n}`);
  if (!statSync(n).isFile()) throw new Error(`${what} is not a file: ${n}`);
  return n.replace(/\\/g, "/");
}

/** True when the output path should be treated as a folder (trailing slash, no extension, or existing directory). */
export function looksLikeFolder(p: string): boolean {
  if (/[\\/]$/.test(p)) return true;
  if (existsSync(p) && statSync(p).isDirectory()) return true;
  return extname(p) === "";
}

// ───────────────────────────── ExtendScript helpers ─────────────────────────────
// Written with String.raw so regex backslashes survive; never use `${` inside.

export const LC_HELPERS = String.raw`
function __lcTrim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }
function __lcRound(n) { return Math.round(Number(n) * 1000) / 1000; }
function __lcRoundArr(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(__lcRound(a[i])); return o; }

function __lcEnter() {
  var s = {};
  try { s.ui = app.scriptPreferences.userInteractionLevel; app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT; } catch (e) {}
  try { s.mu = app.scriptPreferences.measurementUnit; app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS; } catch (e) {}
  return s;
}
function __lcLeave(s) {
  if (!s) return;
  try { if (s.mu !== undefined) app.scriptPreferences.measurementUnit = s.mu; } catch (e) {}
  try { if (s.ui !== undefined) app.scriptPreferences.userInteractionLevel = s.ui; } catch (e) {}
}

function __lcErr(e) {
  var m = (e && e.message) ? e.message : String(e);
  if (e && e.line) m += ' (line ' + e.line + ')';
  return m;
}

// Returns null when the document may be modified, otherwise the reason it may not.
function __lcGuardWrite(doc) {
  var p = null;
  try { if (doc.saved) p = doc.fullName.fsName; } catch (e) { p = null; }
  if (p === null) return null; // never saved: no file on disk can be harmed
  var lp = String(p).replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)brac_test_master\.indd$/.test(lp)) return 'Refusing to modify the pristine test master (' + p + '). Copy it to test_fixtures/runs/<label>.indd and open the copy.';
  for (var i = 0; i < __LC_WRITE_ROOTS.length; i++) {
    var r = __LC_WRITE_ROOTS[i];
    if (lp.indexOf(r + '/') === 0) return null;
  }
  return 'Refusing to modify "' + p + '": it is outside the write roots (' + __LC_WRITE_ROOTS.join('; ') + '). Work on a copy under one of them, or set INDESIGN_MCP_WRITE_ROOTS.';
}

function __lcSnapPrefs(obj, props) {
  var snap = [];
  for (var i = 0; i < props.length; i++) {
    try { snap.push([props[i], obj[props[i]]]); } catch (e) {}
  }
  return snap;
}
function __lcRestorePrefs(obj, snap) {
  for (var i = 0; i < snap.length; i++) {
    try { obj[snap[i][0]] = snap[i][1]; } catch (e) {}
  }
}

// ── pages ──
function __lcPageAt(doc, idx) {
  var n = doc.pages.length;
  if (typeof idx !== 'number' || isNaN(idx) || idx % 1 !== 0 || idx < 0 || idx >= n) {
    throw new Error('pageIndex ' + idx + ' is out of range: "' + doc.name + '" has ' + n + ' pages (0-based indices 0..' + (n - 1) + ')');
  }
  return doc.pages[idx];
}
function __lcPagesNamed(doc, name) {
  var out = [];
  for (var i = 0; i < doc.pages.length; i++) { if (doc.pages[i].name === name) out.push(doc.pages[i]); }
  return out;
}
function __lcPageByName(doc, name) {
  var m = __lcPagesNamed(doc, name);
  if (m.length === 0) throw new Error('No page named "' + name + '" in "' + doc.name + '"');
  if (m.length > 1) {
    var offs = [];
    for (var i = 0; i < m.length; i++) offs.push(m[i].documentOffset);
    throw new Error('Page name "' + name + '" is ambiguous (' + m.length + ' pages share it, at indices ' + offs.join(', ') + '). Use pageIndex instead.');
  }
  return m[0];
}
function __lcSide(page) {
  try {
    var s = page.side;
    if (s == PageSideOptions.LEFT_HAND) return 'left';
    if (s == PageSideOptions.RIGHT_HAND) return 'right';
    return 'single';
  } catch (e) { return 'unknown'; }
}
function __lcSides(doc) {
  var m = {};
  for (var i = 0; i < doc.pages.length; i++) { var p = doc.pages[i]; m['p' + p.id] = __lcSide(p); }
  return m;
}
function __lcParity(doc, before) {
  var flipped = [], count = 0;
  for (var i = 0; i < doc.pages.length; i++) {
    var p = doc.pages[i], k = 'p' + p.id;
    if (before[k] === undefined) continue;
    var now = __lcSide(p);
    if (before[k] !== now) {
      count++;
      if (flipped.length < 20) flipped.push({ index: i, name: p.name, before: before[k], after: now });
    }
  }
  var facing = false;
  try { facing = doc.documentPreferences.facingPages; } catch (e) {}
  return {
    facingPages: facing,
    flippedCount: count,
    flipped: flipped,
    warning: count > 0 ? (count + ' existing page(s) changed side (left/right). Facing-page layouts (inside/outside margins, page numbers, mirrored items) on those pages are now on the wrong side. Add/remove pages in pairs (a whole spread) to keep parity.') : null
  };
}
// Page-relative points -> spread (ruler) coordinates. Works for any ruler origin
// because page.bounds and geometricBounds share the same coordinate system.
function __lcPageToSpread(page, b) {
  var pb = page.bounds;
  return [pb[0] + b[0], pb[1] + b[1], pb[0] + b[2], pb[1] + b[3]];
}
function __lcSpreadToPage(page, b) {
  var pb = page.bounds;
  return [__lcRound(b[0] - pb[0]), __lcRound(b[1] - pb[1]), __lcRound(b[2] - pb[0]), __lcRound(b[3] - pb[1])];
}
function __lcPagePoint(page, xy) { var pb = page.bounds; return [pb[1] + xy[0], pb[0] + xy[1]]; }
// Page-relative margin box [top, left, bottom, right]. On facing pages
// marginPreferences.left is the INSIDE margin, which sits on the right of a left-hand page.
function __lcMarginBox(page) {
  var pb = page.bounds, mp = page.marginPreferences;
  var l = mp.left, r = mp.right;
  if (__lcSide(page) === 'left') { l = mp.right; r = mp.left; }
  return [mp.top, l, (pb[2] - pb[0]) - mp.bottom, (pb[3] - pb[1]) - r];
}
function __lcRelBounds(item) {
  try { var pg = item.parentPage; if (pg) return __lcSpreadToPage(pg, item.geometricBounds); } catch (e) {}
  return null;
}
function __lcIntersects(a, b) { return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }
// Top-level items of the page (not master items) whose bounds intersect the page-relative box.
function __lcOverlaps(page, box) {
  var hits = [];
  var abs = __lcPageToSpread(page, box);
  for (var i = 0; i < page.pageItems.length; i++) {
    var it = page.pageItems[i];
    try { if (__lcIntersects(it.geometricBounds, abs)) hits.push({ id: it.id, type: it.constructor.name, name: it.name || '' }); } catch (e) {}
  }
  return hits;
}
// "1-3,+5,+7-+9,A" -> sorted unique 0-based page offsets. "+N" = absolute (1-based) page; other tokens are page names.
function __lcResolvePageSpec(doc, spec) {
  var n = doc.pages.length, out = [], seen = {};
  function add(i) { if (!seen['i' + i]) { seen['i' + i] = true; out.push(i); } }
  function one(tok) {
    tok = __lcTrim(tok);
    if (/^\+\d+$/.test(tok)) {
      var k = parseInt(tok.substr(1), 10) - 1;
      if (k < 0 || k >= n) throw new Error('Absolute page ' + tok + ' is out of range (document has ' + n + ' pages)');
      return k;
    }
    return __lcPageByName(doc, tok).documentOffset;
  }
  var parts = String(spec).split(',');
  for (var p = 0; p < parts.length; p++) {
    var part = __lcTrim(parts[p]);
    if (part === '') continue;
    if (/^\+\d+$/.test(part) || __lcPagesNamed(doc, part).length === 1) { add(one(part)); continue; }
    var dash = part.indexOf('-', 1);
    if (dash > 0) {
      var a = one(part.substr(0, dash)), b = one(part.substr(dash + 1));
      if (a > b) { var t = a; a = b; b = t; }
      for (var i = a; i <= b; i++) add(i);
    } else {
      add(one(part));
    }
  }
  out.sort(function (x, y) { return x - y; });
  return out;
}

// ── items ──
function __lcItemById(doc, id) {
  var n = Number(id);
  try {
    var it = doc.pageItems.itemByID(n);
    if (it && it.isValid) return it.getElements()[0];
  } catch (e) {}
  try {
    var all = doc.allPageItems;
    for (var i = 0; i < all.length; i++) { if (all[i].id === n) return all[i]; }
  } catch (e) {}
  try {
    for (var m = 0; m < doc.masterSpreads.length; m++) {
      var mi = doc.masterSpreads[m].allPageItems;
      for (var j = 0; j < mi.length; j++) { if (mi[j].id === n) return mi[j]; }
    }
  } catch (e) {}
  return null;
}
function __lcRequireItem(doc, id, label, typeName) {
  var it = __lcItemById(doc, id);
  if (!it) throw new Error((label || 'Item') + ' id ' + id + ' not found in "' + doc.name + '" (searched top-level, grouped, anchored and master-page items)');
  if (typeName && it.constructor.name !== typeName) throw new Error((label || 'Item') + ' id ' + id + ' is a ' + it.constructor.name + ', expected a ' + typeName);
  return it;
}

// ── named resources ──
function __lcSwatch(doc, name) {
  var s = doc.swatches.itemByName(name);
  if (!s.isValid) throw new Error('Swatch "' + name + '" not found in "' + doc.name + '"');
  return s;
}
function __lcLayer(doc, name) {
  var l = doc.layers.itemByName(name);
  if (!l.isValid) {
    var names = [];
    for (var i = 0; i < doc.layers.length; i++) names.push(doc.layers[i].name);
    throw new Error('Layer "' + name + '" not found. Layers: ' + names.join(', '));
  }
  return l;
}
function __lcMaster(doc, name) {
  if (name === '[None]' || name === 'None') return NothingEnum.NOTHING;
  var m = doc.masterSpreads.itemByName(name);
  if (m.isValid) return m;
  var hits = [], names = [];
  for (var i = 0; i < doc.masterSpreads.length; i++) {
    var ms = doc.masterSpreads[i];
    names.push(ms.name);
    if (ms.baseName === name || ms.namePrefix === name) hits.push(ms);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error('Master "' + name + '" is ambiguous; use the full name. Masters: ' + names.join(', '));
  throw new Error('Master spread "' + name + '" not found. Masters: ' + names.join(', '));
}
function __lcStylePath(st) {
  var path = st.name, p = st.parent;
  try {
    while (p && p.constructor && /StyleGroup$/.test(p.constructor.name)) { path = p.name + '/' + path; p = p.parent; }
  } catch (e) {}
  return path;
}
// kind: 'paragraph' | 'character' | 'table' | 'cell' | 'object'. Accepts "Group/Name" or a unique bare name.
function __lcFindStyle(doc, kind, name) {
  var coll = doc['all' + kind.charAt(0).toUpperCase() + kind.substr(1) + 'Styles'];
  var byName = [];
  for (var i = 0; i < coll.length; i++) {
    var st = coll[i];
    if (__lcStylePath(st) === name) return st;
    if (st.name === name) byName.push(st);
  }
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    var paths = [];
    for (var j = 0; j < byName.length; j++) paths.push(__lcStylePath(byName[j]));
    throw new Error(kind + ' style "' + name + '" is ambiguous: ' + paths.join(', ') + '. Use the Group/Name path.');
  }
  throw new Error(kind + ' style "' + name + '" not found');
}

// ── tables ──
function __lcTable(doc, frameId, tableIndex, tableId) {
  if (tableId !== null && tableId !== undefined) {
    for (var s = 0; s < doc.stories.length; s++) {
      var ts = doc.stories[s].tables;
      for (var t = 0; t < ts.length; t++) { if (ts[t].id === tableId) return ts[t]; }
    }
    throw new Error('Table id ' + tableId + ' not found in any story of "' + doc.name + '"');
  }
  if (frameId === null || frameId === undefined) throw new Error('Pass frameId (text frame containing the table) or tableId');
  var tf = __lcRequireItem(doc, frameId, 'Text frame', 'TextFrame');
  var n = tf.tables.length;
  var ti = (tableIndex === null || tableIndex === undefined) ? 0 : tableIndex;
  if (n === 0) throw new Error('Text frame id ' + frameId + ' contains no tables');
  if (ti % 1 !== 0 || ti < 0 || ti >= n) throw new Error('tableIndex ' + ti + ' out of range: frame ' + frameId + ' has ' + n + ' table(s)');
  return tf.tables[ti];
}
// Address a cell by (row, column) using the "column:row" cell name, which stays
// correct with merged cells; a cell covered by a merge resolves to the merged cell.
function __lcCell(table, row, col) {
  var rows = table.rows.length, cols = table.columns.length;
  if (row % 1 !== 0 || row < 0 || row >= rows) throw new Error('row ' + row + ' out of range (table has ' + rows + ' rows, 0-based, header rows included)');
  if (col % 1 !== 0 || col < 0 || col >= cols) throw new Error('column ' + col + ' out of range (table has ' + cols + ' columns, 0-based)');
  var c = table.cells.itemByName(col + ':' + row);
  if (c.isValid) return c;
  for (var i = 0; i < table.cells.length; i++) {
    var cell = table.cells[i];
    var parts = String(cell.name).split(':');
    var cc = parseInt(parts[0], 10), rr = parseInt(parts[1], 10);
    if (row >= rr && row < rr + cell.rowSpan && col >= cc && col < cc + cell.columnSpan) return cell;
  }
  throw new Error('No cell at row ' + row + ', column ' + col);
}

function __lcLorem(tf) {
  try { return /lorem|ipsum/i.test(String(tf.texts[0].contents)); } catch (e) { return false; }
}
`;

// ───────────────────────────── runner ─────────────────────────────

export interface LcRunOptions {
  /** Wrap in one undo step with this name. */
  undoName?: string;
  /** Script modifies the document: refuse documents outside the write roots and the test master. */
  mutating?: boolean;
  /** Set false for scripts that do not need a document (e.g. list_pdf_presets). Default true. */
  needsDocument?: boolean;
}

/** Build the script: helpers + IIFE that resolves `doc`, applies the guard, runs `body` (which must `return __ok(...)`/`__fail(...)`). */
export function buildLC(body: string, opts: LcRunOptions = {}): string {
  const roots = writeRootKeysForScript().map((r) => jsStr(r));
  const needsDoc = opts.needsDocument !== false;
  return `${LC_HELPERS}
var __LC_WRITE_ROOTS = [${roots.join(",")}];
(function () {
  var __lcState = __lcEnter();
  try {
    ${needsDoc ? "if (app.documents.length === 0) return __fail('No document is open');\n    var doc = __resolveDocument();" : ""}
    ${needsDoc && opts.mutating ? "var __lcG = __lcGuardWrite(doc); if (__lcG) return __fail(__lcG);" : ""}
    ${body}
  } catch (__lcE) {
    return __fail(__lcErr(__lcE));
  } finally {
    __lcLeave(__lcState);
  }
})();`;
}

export async function runLC(bridge: InDesignBridge, body: string, opts: LcRunOptions = {}): Promise<ScriptResult> {
  // mutating also turns on batch A's in-script write guard (__mcpAssertWritable);
  // the batch C guard inside the IIFE is a second, independent check.
  const run: RunOptions = { mutating: !!opts.mutating };
  if (opts.undoName) run.undoName = opts.undoName;
  return bridge.runScript(buildLC(body, opts), run);
}

/** Wrap a handler so argument-validation errors come back as a failed ScriptResult instead of a thrown exception. */
export function lcHandler(fn: (args: Record<string, unknown>) => Promise<ScriptResult>) {
  return async (args: Record<string, unknown>): Promise<ScriptResult> => {
    try {
      return await fn(args ?? {});
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

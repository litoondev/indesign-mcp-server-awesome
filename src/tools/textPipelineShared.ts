/**
 * Shared helpers for the text/content pipeline (batch B: content.ts, text.ts,
 * template.ts, style.ts, safeContent.ts).
 *
 * Batch A is adding src/bridge/jsStr.ts, src/bridge/safety.ts and the
 * __itemById/__findStyle/__pageToSpread helpers. At the time batch B was written
 * none of those files existed, so this module carries self-contained equivalents
 * with a `__tp_` prefix (ExtendScript side) so they can never collide with the
 * batch A globals. The write-path policy (writeRoots / isUnderWriteRoots /
 * assertSafeWritePath) delegates to src/bridge/safety.ts plus the single
 * Downloads rule in ./batchB_writePolicy.ts; exported names and signatures are
 * unchanged so callers (content.ts, template.ts) need no edits.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InDesignBridge } from "../bridge/index.js";
import { assertSafeWritePath as bridgeAssertSafeWritePath, getWriteRoots } from "../bridge/safety.js";
import { assertNotBlockedDownloads, isWritablePath, writeRootKeysForScript } from "./batchB_writePolicy.js";
import type { WrapOptions } from "../bridge/wrapExtendScript.js";
import type { ScriptResult } from "../types.js";

/** Tag for ExtendScript source blocks: keeps backslashes literal (\r, \uFFFC, \d ...). */
export const jsx = String.raw;

// ─────────────────────────────────────────────────────────────────────────────
// Literal encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode any value as an ExtendScript string literal. JSON.stringify escapes
 * quotes, backslashes, \r, \n, \t and control characters; U+2028/U+2029 are
 * escaped as well because they terminate lines in ES3 engines.
 */
const LS_RE = new RegExp("\\u2028", "g");
const PS_RE = new RegExp("\\u2029", "g");

export function jsStr(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return JSON.stringify(s).replace(LS_RE, "\\u2028").replace(PS_RE, "\\u2029");
}

/** Encode a JSON-compatible value (object/array) as an ExtendScript literal. */
export function jsJson(v: unknown): string {
  return JSON.stringify(v ?? null).replace(LS_RE, "\\u2028").replace(PS_RE, "\\u2029");
}

/** Validate and encode a finite number. Throws a descriptive error otherwise. */
export function jsNum(
  v: unknown,
  name: string,
  opts: { int?: boolean; min?: number; max?: number } = {}
): string {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number (got ${JSON.stringify(v)})`);
  }
  if (opts.int && !Number.isInteger(n)) throw new Error(`${name} must be an integer (got ${n})`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${name} must be >= ${opts.min} (got ${n})`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${name} must be <= ${opts.max} (got ${n})`);
  return String(n);
}

/** Optional number: returns "null" when absent. */
export function jsNumOpt(v: unknown, name: string, opts: { int?: boolean; min?: number; max?: number } = {}): string {
  if (v === undefined || v === null) return "null";
  return jsNum(v, name, opts);
}

/** Normalise source text: CRLF -> CR (paragraph); a lone LF stays LF (forced line break). */
export function normalizeText(s: unknown): string {
  return String(s ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\r");
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-path safety: delegates to src/bridge/safety.ts (single policy).
// ─────────────────────────────────────────────────────────────────────────────

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEST_OUTPUT_DIR = path.join(PROJECT_ROOT, "test_output");
export const BACKUP_ROOT = path.join(TEST_OUTPUT_DIR, "_backups");

/** The configured write roots (bridge/safety: INDESIGN_MCP_WRITE_ROOTS or the defaults). */
export function writeRoots(): string[] {
  return getWriteRoots();
}

/**
 * True when `p` is inside a write root (realpath-normalised, bridge/safety) and
 * not blocked by the Downloads rule (batchB_writePolicy).
 */
export function isUnderWriteRoots(p: string): boolean {
  return isWritablePath(p);
}

/**
 * Throws unless `p` is an allowed write target: inside a write root, with one of
 * `exts`, never the pristine test master, not under a Downloads folder unless
 * that folder is listed in INDESIGN_MCP_WRITE_ROOTS, and (unless overwrite) not
 * already existing. Returns the resolved absolute path. All checks except the
 * Downloads rule are bridge/safety's assertSafeWritePath.
 */
export function assertSafeWritePath(p: unknown, exts: string[], opts: { overwrite?: boolean } = {}): string {
  if (typeof p === "string" && p.trim()) assertNotBlockedDownloads(path.resolve(p.trim()));
  return bridgeAssertSafeWritePath(p, exts.length ? exts : null, { overwrite: opts.overwrite === true });
}

/** Forward-slash form for ExtendScript `new File(...)`. */
export function toJsxPath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ─────────────────────────────────────────────────────────────────────────────
// ExtendScript helpers (prefixed __tp_ so they cannot collide with batch A)
// ─────────────────────────────────────────────────────────────────────────────

export const TP_HELPERS = jsx`
function __tp_valid(o) { try { return !!(o && o.isValid); } catch (e) { return false; } }
function __tp_concrete(o) { try { var els = o.getElements(); if (els && els.length) return els[0]; } catch (e) {} return o; }
function __tp_type(o) { try { return o.constructor.name; } catch (e) { return ''; } }
function __tp_round(n) { return Math.round(n * 1000) / 1000; }
function __tp_now() { return new Date().getTime(); }
function __tp_arr(v) { if (v === null || v === undefined) return []; if (v instanceof Array) return v; return [v]; }

// Resolve any page item (top level, grouped, anchored, master) by id.
function __tp_itemById(doc, id) {
  id = Number(id);
  if (isNaN(id)) return null;
  var c = null;
  try { c = doc.pageItems.itemByID(id); if (__tp_valid(c)) return __tp_concrete(c); } catch (e) {}
  try { c = doc.textFrames.itemByID(id); if (__tp_valid(c)) return __tp_concrete(c); } catch (e) {}
  try { c = doc.groups.itemByID(id); if (__tp_valid(c)) return __tp_concrete(c); } catch (e) {}
  var all = doc.allPageItems;
  for (var i = 0; i < all.length; i++) { if (all[i].id === id) return all[i]; }
  for (var m = 0; m < doc.masterSpreads.length; m++) {
    var mi = doc.masterSpreads[m].allPageItems;
    for (var j = 0; j < mi.length; j++) { if (mi[j].id === id) return mi[j]; }
  }
  return null;
}
function __tp_requireItem(doc, id, what) {
  var it = __tp_itemById(doc, id);
  if (!it) throw new Error((what || 'item') + ' not found: id ' + id);
  return it;
}
function __tp_requireTextFrame(doc, id) {
  var it = __tp_itemById(doc, id);
  if (!it || __tp_type(it) !== 'TextFrame') throw new Error('frame not found: text frame id ' + id);
  return it;
}
function __tp_requireStory(doc, storyId, frameId) {
  if (storyId !== null && storyId !== undefined) {
    var s = doc.stories.itemByID(Number(storyId));
    if (!__tp_valid(s)) throw new Error('story not found: id ' + storyId);
    return s;
  }
  if (frameId !== null && frameId !== undefined) return __tp_requireTextFrame(doc, frameId).parentStory;
  throw new Error('storyId or frameId is required');
}

// Style lookup by id, group path ("Group/Sub/Name") or unique exact name.
function __tp_stylePath(st) {
  var parts = [st.name];
  try {
    var p = st.parent;
    while (p && /StyleGroup$/.test(__tp_type(p))) { parts.unshift(p.name); p = p.parent; }
  } catch (e) {}
  return parts.join('/');
}
function __tp_styleList(doc, kind) {
  if (kind === 'paragraph') return doc.allParagraphStyles;
  if (kind === 'character') return doc.allCharacterStyles;
  if (kind === 'object') return doc.allObjectStyles;
  throw new Error('unknown style kind: ' + kind);
}
function __tp_findStyle(doc, kind, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  var all = __tp_styleList(doc, kind);
  var s = String(ref);
  if (typeof ref === 'number' || /^\d+$/.test(s)) {
    var idn = Number(s);
    for (var i = 0; i < all.length; i++) { if (all[i].id === idn) return all[i]; }
    if (typeof ref === 'number') return null;
  }
  var exact = [];
  for (var j = 0; j < all.length; j++) {
    if (s.indexOf('/') >= 0 && __tp_stylePath(all[j]) === s) return all[j];
    if (all[j].name === s) exact.push(all[j]);
  }
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    var paths = [];
    for (var k = 0; k < exact.length; k++) paths.push(__tp_stylePath(exact[k]) + ' (id ' + exact[k].id + ')');
    throw new Error(kind + " style name '" + s + "' is ambiguous: " + paths.join(', ') + '. Pass the group path or id.');
  }
  return null;
}
function __tp_requireStyle(doc, kind, ref) {
  var st = __tp_findStyle(doc, kind, ref);
  if (!st) throw new Error(kind + ' style not found: ' + ref);
  return st;
}

// Pages
function __tp_requirePage(doc, idx) {
  idx = Number(idx);
  if (isNaN(idx) || idx < 0 || idx >= doc.pages.length) throw new Error('pageIndex out of range: ' + idx + ' (document has ' + doc.pages.length + ' pages, 0-based)');
  return doc.pages[idx];
}
function __tp_pageByName(doc, name) {
  var hits = [];
  for (var i = 0; i < doc.pages.length; i++) { if (doc.pages[i].name === String(name)) hits.push(doc.pages[i]); }
  if (hits.length === 0) throw new Error('page name not found: ' + name);
  if (hits.length > 1) {
    var offs = [];
    for (var j = 0; j < hits.length; j++) offs.push(hits[j].documentOffset);
    throw new Error("page name '" + name + "' matches " + hits.length + ' pages (sectioned book), documentOffsets ' + offs.join(', ') + '. Use pageIndex.');
  }
  return hits[0];
}
function __tp_side(page) {
  try {
    if (page.side === PageSideOptions.LEFT_HAND) return 'left';
    if (page.side === PageSideOptions.RIGHT_HAND) return 'right';
    return 'single';
  } catch (e) { return 'unknown'; }
}
function __tp_pageInfo(page) {
  var m = '';
  try { m = page.appliedMaster ? page.appliedMaster.name : ''; } catch (e) {}
  return { name: page.name, documentOffset: page.documentOffset, side: __tp_side(page), master: m };
}
// Page-relative <-> spread (document coordinate system) bounds. Both use
// page.bounds, which is expressed in the same coordinate system as item bounds
// whatever the ruler origin is.
function __tp_pageToSpread(page, b) { var pb = page.bounds; return [b[0] + pb[0], b[1] + pb[1], b[2] + pb[0], b[3] + pb[1]]; }
function __tp_spreadToPage(page, b) { var pb = page.bounds; return [b[0] - pb[0], b[1] - pb[1], b[2] - pb[0], b[3] - pb[1]]; }
// Margin box of a page in item coordinates (inside/outside mirrored on left-hand pages).
function __tp_marginBox(page) {
  var pb = page.bounds, mp = page.marginPreferences;
  var l = mp.left, r = mp.right;
  if (__tp_side(page) === 'left') { l = mp.right; r = mp.left; }
  return [pb[0] + mp.top, pb[1] + l, pb[2] - mp.bottom, pb[3] - r];
}
function __tp_isAnchored(item) { try { var t = __tp_type(item.parent); return t === 'Character' || t === 'InsertionPoint' || t === 'Text'; } catch (e) { return false; } }
function __tp_isMasterOverride(item) { try { var o = item.overriddenMasterPageItem; return !!(o && o.isValid); } catch (e) { return false; } }
function __tp_onLockedLayer(item) { try { return item.itemLayer.locked === true; } catch (e) { return false; } }

// Text helpers
function __tp_count(s, ch) { var n = 0; for (var i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++; return n; }
function __tp_isBoldStyle(fs) { return /Bold|Heavy|Black/i.test(String(fs)); }
function __tp_isMediumStyle(fs) { return /Medium|Semibold|Demi/i.test(String(fs)) && !__tp_isBoldStyle(fs); }
function __tp_str(v) { if (typeof v === 'string') return v; try { return String(v); } catch (e) { return ''; } }
function __tp_name(o) { try { return o && o.name !== undefined ? String(o.name) : ''; } catch (e) { return ''; } }
function __tp_anchorCount(story) { return __tp_count(__tp_str(story.contents), '\uFFFC'); }

// Text style runs of a text object, offsets relative to the object start.
// Uses everyItem() so each property is ONE DOM round trip regardless of run count.
function __tp_runs(textObj, objStart, objEndExcl, withText) {
  var runs = [];
  var col = textObj.textStyleRanges;
  if (col.length === 0) return runs;
  var ev = col.everyItem();
  var idx = __tp_arr(ev.index);
  var fstyle = __tp_arr(ev.fontStyle);
  var fonts = __tp_arr(ev.appliedFont);
  var sizes = __tp_arr(ev.pointSize);
  var fills = __tp_arr(ev.fillColor);
  var cstyles = __tp_arr(ev.appliedCharacterStyle);
  var conts = withText ? __tp_arr(ev.contents) : null;
  for (var i = 0; i < idx.length; i++) {
    var s = idx[i] - objStart;
    var e = (i + 1 < idx.length ? idx[i + 1] : objEndExcl) - objStart;
    if (s < 0) s = 0;
    if (e > objEndExcl - objStart) e = objEndExcl - objStart;
    var fsn = __tp_str(fstyle[i]);
    var r = {
      start: s, endExclusive: e,
      fontStyle: fsn,
      fontName: __tp_name(fonts[i]),
      pointSize: typeof sizes[i] === 'number' ? __tp_round(sizes[i]) : null,
      fillColor: __tp_name(fills[i]),
      charStyle: __tp_name(cstyles[i]),
      bold: __tp_isBoldStyle(fsn),
      medium: __tp_isMediumStyle(fsn)
    };
    if (withText) {
      // A text style range can start before / end after the object (it spans
      // paragraphs); clip its contents to [s, e) of the object so the run text
      // never spills into the neighbouring paragraph.
      var full = typeof conts[i] === 'string' ? conts[i] : __tp_str(conts[i]);
      var off = (objStart + s) - idx[i];
      if (off < 0) off = 0;
      r.text = (typeof conts[i] === 'string' && e > s) ? full.substring(off, off + (e - s)) : (e > s ? full : '');
    }
    runs.push(r);
  }
  return runs;
}

// EFFECTIVE formatting runs of a text object (offsets relative to objStart).
// textStyleRanges only split on LOCAL formatting, so text formatted by a GREP or
// nested style is reported with the formatting of its range; the per-character
// properties read here (fontStyle, appliedFont, pointSize, fillColor) are the
// composed values. Consecutive characters with equal values are merged. Same
// fields as __tp_runs plus source:'effective'. Each property is ONE everyItem()
// round trip; object names are only resolved when the wrapper changes.
function __tp_effectiveRuns(textObj, objStart, objEndExcl, withText) {
  var runs = [];
  var col = textObj.characters, n = 0;
  try { n = col.length; } catch (e0) { n = 0; }
  if (!n) return runs;
  var ev = col.everyItem();
  var fstyle = __tp_arr(ev.fontStyle), fonts = __tp_arr(ev.appliedFont), sizes = __tp_arr(ev.pointSize);
  var fills = __tp_arr(ev.fillColor), cstyles = __tp_arr(ev.appliedCharacterStyle);
  var base = 0; try { base = textObj.insertionPoints[0].index - objStart; } catch (eB) {}
  var limit = objEndExcl - objStart;
  var full = null, perChar = null;
  if (withText) {
    full = __tp_str(textObj.contents);
    if (full.length !== n) { try { perChar = __tp_arr(ev.contents); } catch (eC) { perChar = []; } }
  }
  function nm(arr, i, cache) {
    if (i > 0 && cache.i === i - 1 && arr[i] === arr[i - 1]) { cache.i = i; return cache.v; }
    cache.v = __tp_name(arr[i]);
    cache.i = i;
    return cache.v;
  }
  var cF = {}, cK = {}, cS = {}, cur = null;
  for (var i = 0; i < n; i++) {
    var off = base + i;
    if (off < 0 || off >= limit) continue;
    var fsn = __tp_str(fstyle[i]);
    var fon = nm(fonts, i, cF), fil = nm(fills, i, cK), csn = nm(cstyles, i, cS);
    var sz = typeof sizes[i] === 'number' ? __tp_round(sizes[i]) : null;
    if (cur && cur.fontStyle === fsn && cur.fontName === fon && cur.fillColor === fil && cur.charStyle === csn && cur.pointSize === sz && cur.endExclusive === off) {
      cur.endExclusive = off + 1;
      continue;
    }
    cur = { start: off, endExclusive: off + 1, fontStyle: fsn, fontName: fon, pointSize: sz, fillColor: fil, charStyle: csn,
            bold: __tp_isBoldStyle(fsn), medium: __tp_isMediumStyle(fsn), source: 'effective' };
    runs.push(cur);
  }
  if (withText) {
    for (var r = 0; r < runs.length; r++) {
      var a = runs[r].start - base, b = runs[r].endExclusive - base;
      if (perChar === null) runs[r].text = full.substring(a, b);
      else {
        var t = '';
        for (var k = a; k < b; k++) t += (typeof perChar[k] === 'string' ? perChar[k] : '�');
        runs[r].text = t;
      }
    }
  }
  return runs;
}

// Write text into story range [a, bExcl) (story-relative). The first replaced
// character's formatting is kept (range.contents = ...). A lone '\n' becomes a
// forced line break. Returns the story index just after the written text.
function __tp_writeAt(story, a, bExcl, text) {
  var parts = String(text).split('\n');
  var pos = a, k = 1;
  if (bExcl > a) {
    var rng = story.characters.itemByRange(a, bExcl - 1);
    if (parts[0] === '' && parts.length > 1) {
      rng.contents = SpecialCharacters.FORCED_LINE_BREAK;
      pos = a + 1;
      if (parts[1].length) { story.insertionPoints[pos].contents = parts[1]; pos += parts[1].length; }
      k = 2;
    } else {
      rng.contents = parts[0];
      pos = a + parts[0].length;
    }
  } else if (parts[0].length) {
    story.insertionPoints[a].contents = parts[0];
    pos = a + parts[0].length;
  }
  for (; k < parts.length; k++) {
    story.insertionPoints[pos].contents = SpecialCharacters.FORCED_LINE_BREAK;
    pos += 1;
    if (parts[k].length) { story.insertionPoints[pos].contents = parts[k]; pos += parts[k].length; }
  }
  return pos;
}

// Delete everything in a paragraph except U+FFFC, tabs and the trailing \r.
// Works last-to-first so indexes stay valid. Optional placeholder replaces the
// first removed run (keeping that run's formatting).
function __tp_clearParagraphKeepAnchors(story, para, placeholder) {
  var start = para.insertionPoints[0].index;
  var txt = __tp_str(para.contents);
  var runs = [], i = 0;
  while (i < txt.length) {
    var ch = txt.charAt(i);
    if (ch === '\r' || ch === '\uFFFC' || ch === '\t') { i++; continue; }
    var j = i;
    while (j < txt.length) { var c2 = txt.charAt(j); if (c2 === '\r' || c2 === '\uFFFC' || c2 === '\t') break; j++; }
    runs.push([i, j]);
    i = j;
  }
  for (var r = runs.length - 1; r >= 0; r--) {
    var rg = story.characters.itemByRange(start + runs[r][0], start + runs[r][1] - 1);
    rg.contents = (r === 0 && placeholder) ? placeholder : '';
  }
  return runs.length;
}

// Shrink every text style range of a story by one common factor (binary search,
// <= maxIter recomposes). Leading scales with size when it is numeric.
function __tp_shrinkStory(story, frame, minSize, minRatio, maxIter, warnings) {
  var col = story.textStyleRanges;
  var ev = col.everyItem();
  var idx = __tp_arr(ev.index), sizes = __tp_arr(ev.pointSize), leads = __tp_arr(ev.leading);
  var end = story.insertionPoints[-1].index;
  var ranges = [];
  for (var i = 0; i < idx.length; i++) {
    var e = (i + 1 < idx.length ? idx[i + 1] : end) - 1;
    var ld = leads[i];
    var numericLead = (typeof ld === 'number' && ld !== Leading.AUTO) ? ld : null;
    if (e >= idx[i] && typeof sizes[i] === 'number') ranges.push({ a: idx[i], b: e, size: sizes[i], lead: numericLead });
  }
  function apply(scale) {
    for (var r = 0; r < ranges.length; r++) {
      var t = story.characters.itemByRange(ranges[r].a, ranges[r].b);
      var ns = Math.max(minSize, ranges[r].size * scale);
      t.pointSize = ns;
      if (ranges[r].lead !== null) t.leading = ranges[r].lead * (ns / ranges[r].size);
    }
    story.recompose();
    return !frame.overflows && !story.overflows;
  }
  var lo = minRatio, hi = 1.0, best = null;
  if (!apply(lo)) { apply(1.0); return { fitted: false, scale: 1.0 }; }
  best = lo;
  for (var it = 0; it < maxIter; it++) {
    var mid = (lo + hi) / 2;
    if (apply(mid)) { best = mid; lo = mid; } else { hi = mid; }
    if (hi - lo < 0.01) break;
  }
  apply(best);
  for (var w = 0; w < ranges.length; w++) {
    var nsz = Math.max(minSize, ranges[w].size * best);
    if (Math.abs(nsz - ranges[w].size) > 0.001) warnings.push('font size changed ' + __tp_round(ranges[w].size) + 'pt -> ' + __tp_round(nsz) + 'pt at story chars ' + ranges[w].a + '-' + ranges[w].b);
  }
  return { fitted: true, scale: __tp_round(best) };
}

// Run fn(doc) with points as the script measurement unit and no dialogs.
// When writeRoots is non-null, the target document must be saved under one of
// them and must not be the pristine test master.
function __tp_run(fn, writeRoots, needDoc) {
  var doc = null;
  if (needDoc !== false) {
    if (app.documents.length === 0) return __fail('No document is open');
    try { doc = __resolveDocument(); } catch (eDoc) { return __fail(String(eDoc && eDoc.message ? eDoc.message : eDoc)); }
  }
  if (doc !== null && writeRoots !== null) {
    var fsn = '';
    try { if (doc.saved) fsn = String(doc.fullName.fsName); } catch (e) {}
    if (/brac_test_master\.indd$/i.test(fsn)) return __fail('Refusing to modify the pristine test master: ' + fsn + '. Copy it to test_fixtures/runs first.');
    if (fsn !== '') {
      var low = fsn.toLowerCase().replace(/\//g, '\\'), okRoot = false;
      for (var r = 0; r < writeRoots.length; r++) {
        var root = String(writeRoots[r]).toLowerCase().replace(/\//g, '\\');
        if (low.indexOf(root + '\\') === 0) { okRoot = true; break; }
      }
      if (!okRoot) return __fail('Refusing to modify ' + fsn + ': it is outside the allowed write roots (' + writeRoots.join('; ') + '). Work on a copy under test_fixtures/runs.');
    }
  }
  var oldMU = null, oldUIL = null;
  try { oldMU = app.scriptPreferences.measurementUnit; app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS; } catch (e) {}
  try { oldUIL = app.scriptPreferences.userInteractionLevel; app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT; } catch (e) {}
  try {
    return fn(doc);
  } catch (err) {
    return __fail(String(err && err.message ? err.message : err) + (err && err.line ? ' (line ' + err.line + ')' : ''));
  } finally {
    try { if (oldMU !== null) app.scriptPreferences.measurementUnit = oldMU; } catch (e) {}
    try { if (oldUIL !== null) app.scriptPreferences.userInteractionLevel = oldUIL; } catch (e) {}
  }
}
`;

export interface TpRunOptions {
  /** Single-step undo name (destructive ops). */
  undoName?: string;
  /** Refuse unless the target document lives under the write roots. */
  mutating?: boolean;
  /** Per-call timeout (honoured once batch A adds it to the bridge options). */
  timeoutMs?: number;
  /** Extra ExtendScript prepended after TP_HELPERS (e.g. the replace_paragraphs core). */
  prelude?: string;
  /** App-level script: `doc` is null and no document needs to be open. */
  noDocument?: boolean;
}

/**
 * Run `body` inside __tp_run(function(doc){ ... }). The body must `return
 * __ok(...)` or `return __fail(...)`. Document targeting comes from
 * args.document_id (passed explicitly as WrapOptions.targetDocument) or from the
 * central injection batch A adds in src/index.ts.
 */
export async function runTp(
  bridge: InDesignBridge,
  args: Record<string, unknown>,
  body: string,
  opts: TpRunOptions = {}
): Promise<ScriptResult> {
  const roots = opts.mutating ? jsJson(writeRootKeysForScript()) : "null";
  const script =
    TP_HELPERS +
    "\n" +
    (opts.prelude ?? "") +
    `\nvar __tpResult = __tp_run(function (doc) {\n${body}\n}, ${roots}, ${opts.noDocument ? "false" : "true"});\n__tpResult;`;
  const options: Record<string, unknown> = {};
  if (!opts.noDocument && args.document_id !== undefined && args.document_id !== null && args.document_id !== "") {
    options.targetDocument = args.document_id as string | number;
  }
  if (opts.undoName) options.undoName = opts.undoName;
  if (opts.timeoutMs) options.timeoutMs = opts.timeoutMs;
  return bridge.runScript(script, options as WrapOptions);
}

/** Convert thrown validation errors into a ScriptResult failure. */
export async function guarded(fn: () => Promise<ScriptResult>): Promise<ScriptResult> {
  try {
    return await fn();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

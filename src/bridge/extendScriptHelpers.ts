/**
 * Shared ExtendScript helpers injected into every script (see wrapExtendScript).
 *
 * Written with String.raw: the ExtendScript source reads exactly as below.
 * Do not use backticks or "${" inside.
 *
 * Globals provided by the wrapper before these helpers run:
 *   __TARGET_DOCUMENT_ID  full path / name / index / null
 *   __MCP_WRITE_ROOTS     normalized ('/'-separated, lower-case) allowed roots
 *   __MCP_DOWNLOADS_ALLOWED explicit roots that lie inside a Downloads folder
 *   __MCP_PROTECTED       protected basenames (lower-case)
 */
export const EXTENDSCRIPT_HELPERS = String.raw`
// -- String escaping --
function __escapeJsx(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function __mcpGet(fn, def) {
  try { var v = fn(); return (typeof v === 'undefined') ? def : v; } catch (e) { return def; }
}

// -- Paths --
function __mcpNormPath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Full file-system path of a document, or '' when it was never saved. */
function __docPath(doc) {
  try { return doc.fullName ? String(doc.fullName.fsName) : ''; } catch (e) { return ''; }
}

function __mcpBasename(p) {
  var s = __mcpNormPath(p);
  var i = s.lastIndexOf('/');
  return i >= 0 ? s.substring(i + 1) : s;
}

function __mcpUnder(key, root) {
  return key === root || key.indexOf(root + '/') === 0;
}

/**
 * Downloads rule (mirrors bridge/safety downloadsBlockReason): a path with a
 * '/downloads/' ancestor is blocked unless an explicit root inside that
 * Downloads folder (__MCP_DOWNLOADS_ALLOWED) covers it. ES3: no Array.indexOf.
 */
function __mcpDownloadsBlocked(p) {
  var key = __mcpNormPath(p);
  var parts = key.split('/');
  var dl = null;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === 'downloads') { dl = parts.slice(0, i + 1).join('/'); break; }
  }
  if (dl === null) return false;
  var allowed = (typeof __MCP_DOWNLOADS_ALLOWED !== 'undefined' && __MCP_DOWNLOADS_ALLOWED) ? __MCP_DOWNLOADS_ALLOWED : [];
  for (var a = 0; a < allowed.length; a++) {
    if (__mcpUnder(allowed[a], dl) && __mcpUnder(key, allowed[a])) return false;
  }
  return true;
}

function __mcpIsWritablePath(p) {
  if (!p) return false;
  var key = __mcpNormPath(p);
  var base = __mcpBasename(p);
  for (var b = 0; b < __MCP_PROTECTED.length; b++) { if (base === __MCP_PROTECTED[b]) return false; }
  if (__mcpDownloadsBlocked(p)) return false;
  for (var r = 0; r < __MCP_WRITE_ROOTS.length; r++) {
    if (__mcpUnder(key, __MCP_WRITE_ROOTS[r])) return true;
  }
  return false;
}

/**
 * Throws 'SAFETY: ...' unless doc lives under the allowed write roots and is
 * not under a Downloads folder that no explicit root opens.
 * Untitled documents (never saved) are allowed: they cannot overwrite a file
 * until save_document gives them a (checked) path.
 */
function __mcpAssertWritable(doc) {
  var p = __docPath(doc);
  if (!p) return true;
  if (__mcpDownloadsBlocked(p)) {
    throw new Error('SAFETY: refusing to modify a document under a Downloads folder: ' + p + '. Copy it into a run folder and open the copy (or list that Downloads folder explicitly in INDESIGN_MCP_WRITE_ROOTS).');
  }
  if (!__mcpIsWritablePath(p)) {
    throw new Error('SAFETY: document outside allowed run folders: ' + p + ' (allowed: ' + __MCP_WRITE_ROOTS.join('; ') + '). Copy it into a run folder and open the copy.');
  }
  return true;
}

// -- Document resolution --
function __openDocumentNames() {
  var names = [];
  for (var i = 0; i < app.documents.length; i++) {
    var d = app.documents[i];
    var p = __docPath(d);
    names.push('[' + i + '] ' + d.name + (p ? ' (' + p + ')' : ' (unsaved)'));
  }
  return names.length ? names.join(', ') : '(none)';
}

/**
 * target: null -> front document; number or /^\d+$/ string -> index;
 * otherwise full path (case-insensitive, / or \) first, then exact file name
 * (then case-insensitive name). Several documents with that name -> throws.
 */
function __findDocument(target) {
  var docs = app.documents;
  if (!docs || docs.length === 0) return null;
  if (typeof target === 'undefined' || target === null) return app.activeDocument;
  if (typeof target === 'string' && /^\d+$/.test(target)) target = parseInt(target, 10);
  if (typeof target === 'number') {
    if (target >= 0 && target < docs.length) return docs[target];
    return null;
  }
  var s = String(target);
  var key = __mcpNormPath(s);
  var i;
  for (i = 0; i < docs.length; i++) {
    var p = __docPath(docs[i]);
    if (p && __mcpNormPath(p) === key) return docs[i];
  }
  var matches = [];
  for (i = 0; i < docs.length; i++) { if (docs[i].name === s) matches.push(docs[i]); }
  if (matches.length === 0) {
    for (i = 0; i < docs.length; i++) { if (String(docs[i].name).toLowerCase() === s.toLowerCase()) matches.push(docs[i]); }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    var paths = [];
    for (i = 0; i < matches.length; i++) { paths.push(__docPath(matches[i]) || matches[i].name + ' (unsaved)'); }
    throw new Error("ambiguous document_id '" + s + "', use full path: " + paths.join(' | '));
  }
  return null;
}

function __resolveDocument() {
  if (!app.documents || app.documents.length === 0) {
    throw new Error('No InDesign document is open.');
  }
  if (__TARGET_DOCUMENT_ID === null || typeof __TARGET_DOCUMENT_ID === 'undefined') {
    return app.activeDocument;
  }
  var doc = __findDocument(__TARGET_DOCUMENT_ID);
  if (!doc) {
    throw new Error("document_id '" + __TARGET_DOCUMENT_ID + "' is not open. Open documents: " + __openDocumentNames());
  }
  return doc;
}

// -- Page helpers --
function __findPage(doc, pageNameOrIndex) {
  if (!doc || !doc.pages) return null;
  if (typeof pageNameOrIndex === 'number') {
    return (pageNameOrIndex >= 0 && pageNameOrIndex < doc.pages.length) ? doc.pages[pageNameOrIndex] : null;
  }
  for (var i = 0; i < doc.pages.length; i++) {
    if (doc.pages[i].name === pageNameOrIndex) return doc.pages[i];
  }
  return null;
}

/**
 * Coordinates: geometricBounds and page.bounds are both in spread/ruler
 * coordinates, so page-relative = bounds - page origin. Arrays are
 * [top, left, bottom, right] in the current script units.
 */
function __spreadToPage(page, b) {
  var pb = page.bounds;
  return [b[0] - pb[0], b[1] - pb[1], b[2] - pb[0], b[3] - pb[1]];
}

function __pageToSpread(page, b) {
  var pb = page.bounds;
  return [b[0] + pb[0], b[1] + pb[1], b[2] + pb[0], b[3] + pb[1]];
}

// -- Item helpers --
function __findPageItem(docOrPage, itemIndexOrName) {
  var items = docOrPage.hasOwnProperty('pages') ? docOrPage.allPageItems : docOrPage.pageItems;
  if (!items) return null;
  if (typeof itemIndexOrName === 'number') return items[itemIndexOrName] || null;
  for (var i = 0; i < items.length; i++) {
    if (items[i].name === itemIndexOrName) return items[i];
  }
  return null;
}

/**
 * Page item by its unique id (including items inside groups and anchored
 * objects). Returns the specific type (TextFrame, Rectangle...) or null.
 */
function __itemById(doc, id) {
  var n = Number(id);
  if (isNaN(n)) return null;
  try {
    var it = doc.pageItems.itemByID(n);
    if (it && it.isValid) { try { return it.getElements()[0]; } catch (e0) { return it; } }
  } catch (e) {}
  var all = doc.allPageItems;
  for (var i = 0; i < all.length; i++) {
    try { if (all[i].id === n) return all[i]; } catch (e2) {}
  }
  return null;
}

function __walkItems(parent, callback) {
  if (!parent) return;
  var items = parent.pageItems;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    callback(items[i], i);
    if (items[i].pageItems && items[i].pageItems.length > 0) {
      __walkItems(items[i], callback);
    }
  }
}

function __collectTextFrames(parent) {
  if (!parent) return [];
  var result = [];
  var frames = parent.textFrames;
  if (frames) {
    for (var i = 0; i < frames.length; i++) { result.push(frames[i]); }
  }
  return result;
}

// -- Layer helpers --
function __findLayer(doc, nameOrIndex) {
  if (!doc || !doc.layers) return null;
  if (typeof nameOrIndex === 'number') return doc.layers[nameOrIndex] || null;
  for (var i = 0; i < doc.layers.length; i++) {
    if (doc.layers[i].name === nameOrIndex) return doc.layers[i];
  }
  return null;
}

// -- Style helpers --
var __MCP_STYLE_GROUPS = { ParagraphStyleGroup: 1, CharacterStyleGroup: 1, ObjectStyleGroup: 1, TableStyleGroup: 1, CellStyleGroup: 1 };

/** 'Group/Sub/Name' path of a style ('Name' when not in a group). */
function __stylePath(st) {
  var parts = [st.name];
  var p = __mcpGet(function () { return st.parent; }, null);
  while (p) {
    var cn = __mcpGet(function () { return p.constructor.name; }, '');
    if (!__MCP_STYLE_GROUPS[cn]) break;
    parts.unshift(p.name);
    var cur = p;
    p = __mcpGet(function () { return cur.parent; }, null);
  }
  return parts.join('/');
}

/**
 * Resolve a style by id (number or digit string), 'Group/Name' path, exact
 * name (trailing spaces significant), then trimmed name. Throws with the
 * candidates when the key is ambiguous or not found.
 * kind: 'paragraph' | 'character' | 'object' | 'table' | 'cell'
 */
function __findStyle(doc, kind, key) {
  var list;
  if (kind === 'paragraph') list = doc.allParagraphStyles;
  else if (kind === 'character') list = doc.allCharacterStyles;
  else if (kind === 'object') list = doc.allObjectStyles;
  else if (kind === 'table') list = doc.allTableStyles;
  else if (kind === 'cell') list = doc.allCellStyles;
  else throw new Error("__findStyle: unknown style kind '" + kind + "'");
  if (key === null || typeof key === 'undefined' || key === '') throw new Error(kind + ' style name, path or id is required');
  var i;
  if (typeof key === 'number' || /^\d+$/.test(String(key))) {
    var id = Number(key);
    for (i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    if (typeof key === 'number') throw new Error(kind + ' style id ' + key + ' not found');
  }
  var s = String(key);
  var st = s.replace(/^\s+|\s+$/g, '');
  var byPath = [], exact = [], trimmed = [];
  for (i = 0; i < list.length; i++) {
    var sty = list[i];
    var nm = String(sty.name);
    if (s.indexOf('/') >= 0 && __stylePath(sty) === s) byPath.push(sty);
    if (nm === s) exact.push(sty);
    else if (nm.replace(/^\s+|\s+$/g, '') === st) trimmed.push(sty);
  }
  var pick = byPath.length ? byPath : (exact.length ? exact : trimmed);
  if (pick.length === 1) return pick[0];
  if (pick.length > 1) {
    var c = [];
    for (i = 0; i < pick.length; i++) c.push('"' + __stylePath(pick[i]) + '" (id ' + pick[i].id + ')');
    throw new Error('ambiguous ' + kind + " style '" + s + "'; use a Group/Name path or id: " + c.join(', '));
  }
  var avail = [];
  for (i = 0; i < list.length && avail.length < 60; i++) avail.push('"' + __stylePath(list[i]) + '"');
  throw new Error(kind + " style '" + s + "' not found. Available: " + avail.join(', '));
}

// -- Measurement conversion --
function __mmToPoints(mm) { return mm * 2.834645669291338; }
function __pointsToMm(pt) { return pt / 2.834645669291338; }
function __inchesToPoints(inches) { return inches * 72; }
function __pointsToInches(pt) { return pt / 72; }

// -- Document info extractor --
function __getDocumentInfo(doc) {
  if (!doc) return null;
  var dp = doc.documentPreferences;
  var mp = doc.marginPreferences;
  return {
    name: doc.name,
    filePath: __docPath(doc),
    pages: __mcpGet(function () { return doc.pages.length; }, 0),
    pageWidth: __mcpGet(function () { return dp.pageWidth; }, null),
    pageHeight: __mcpGet(function () { return dp.pageHeight; }, null),
    facingPages: __mcpGet(function () { return dp.facingPages; }, null),
    margins: {
      top: __mcpGet(function () { return mp.top; }, null),
      bottom: __mcpGet(function () { return mp.bottom; }, null),
      left: __mcpGet(function () { return mp.left; }, null),
      right: __mcpGet(function () { return mp.right; }, null)
    },
    bleed: {
      top: __mcpGet(function () { return dp.documentBleedTopOffset; }, 0),
      bottom: __mcpGet(function () { return dp.documentBleedBottomOffset; }, 0),
      left: __mcpGet(function () { return dp.documentBleedInsideOrLeftOffset; }, 0),
      right: __mcpGet(function () { return dp.documentBleedOutsideOrRightOffset; }, 0)
    }
  };
}

// -- Page info extractor --
function __getPageInfo(page) {
  if (!page) return null;
  var b = __mcpGet(function () { return page.bounds; }, null);
  return {
    index: page.index,
    documentOffset: __mcpGet(function () { return page.documentOffset; }, null),
    name: page.name,
    side: __mcpGet(function () { return String(page.side); }, ''),
    bounds: b ? { top: b[0], left: b[1], bottom: b[2], right: b[3] } : null,
    masterSpread: __mcpGet(function () { return page.appliedMaster ? page.appliedMaster.name : ''; }, ''),
    label: __mcpGet(function () { return page.label || ''; }, '')
  };
}

// -- Bounds extractor --
function __getBounds(item) {
  var gb = __mcpGet(function () { return item.geometricBounds; }, null);
  if (!gb) return null;
  return { top: gb[0], left: gb[1], bottom: gb[2], right: gb[3] };
}

// -- Item info extractor (every read guarded: groups with mixed values throw) --
function __getItemInfo(item) {
  if (!item) return null;
  var type = __mcpGet(function () { return item.constructor.name; }, '');
  var info = {
    id: __mcpGet(function () { return item.id; }, null),
    name: __mcpGet(function () { return item.name || ''; }, ''),
    itemType: type,
    bounds: __getBounds(item),
    fillColor: __mcpGet(function () { return item.fillColor ? item.fillColor.name : ''; }, ''),
    strokeColor: __mcpGet(function () { return item.strokeColor ? item.strokeColor.name : ''; }, ''),
    strokeWeight: __mcpGet(function () { return item.strokeWeight || 0; }, null),
    locked: __mcpGet(function () { return item.locked || false; }, null),
    visible: __mcpGet(function () { return item.visible !== false; }, null),
    layer: __mcpGet(function () { return item.itemLayer ? item.itemLayer.name : ''; }, ''),
    parentType: __mcpGet(function () { return item.parent.constructor.name; }, '')
  };
  if (type === 'Group') {
    var kids = __mcpGet(function () { return item.allPageItems; }, []);
    var counts = {};
    var ids = [];
    for (var k = 0; k < kids.length; k++) {
      var kt = __mcpGet(function () { return kids[k].constructor.name; }, 'Unknown');
      counts[kt] = (counts[kt] || 0) + 1;
      if (ids.length < 50) ids.push({ id: __mcpGet(function () { return kids[k].id; }, null), type: kt });
    }
    info.children = { count: kids.length, byType: counts, items: ids };
  }
  return info;
}

// -- Link status helper --
function __linkStatus(link) {
  if (!link) return 'embedded';
  var status = link.status;
  if (status === LinkStatus.NORMAL) return 'normal';
  if (status === LinkStatus.LINK_OUT_OF_DATE) return 'link_out_of_date';
  if (status === LinkStatus.LINK_MISSING) return 'link_missing';
  if (status === LinkStatus.LINK_EMBEDDED) return 'embedded';
  if (status === LinkStatus.LINK_INACCESSIBLE) return 'link_inaccessible';
  return 'unknown';
}

// -- Result wrappers --
function __ok(data) { return JSON.stringify({ ok: true, data: data }); }
function __fail(msg, code) {
  var o = { ok: false, error: String(msg) };
  if (code) o.code = String(code);
  return JSON.stringify(o);
}
function __try(fn) {
  try { return fn(); } catch (e) { return __fail(e && e.message ? e.message : e.toString()); }
}
`;

export function getExtendScriptHelpers(): string {
  return EXTENDSCRIPT_HELPERS;
}

/**
 * Formatting-preserving content tools for the BRAC workflow.
 *
 *   replace_paragraphs      story-relative paragraph edits; keeps anchors, tabs, \r,
 *                           label/value runs, the paragraph style AND the paragraph's
 *                           local overrides (list restarts, indents, keeps). Edit kinds:
 *                           replace (text | label/value, optional restyle), delete,
 *                           insertAfter.
 *   replace_contact_block   maps contact lines onto their icons (group + polygons
 *                           or inline anchored icons, scoped to ONE block of icon
 *                           lines), mismatch instead of overflow
 *   verify_page_invariants  read-only checks for the failures seen in production
 *                           (overlap, Lorem, overset, margins, anchors, gaps, master text)
 *   continue_story          threads overset text into new pages after the story's
 *                           last page (no shrinking, never moves existing items);
 *                           diagnoses what blocks the flow when it cannot continue
 *
 * Registered from content.ts (registerContentTools) so src/index.ts is untouched.
 */
import type { InDesignBridge } from "../bridge/index.js";
import type { ScriptResult } from "../types.js";
import { guarded, jsJson, jsNum, jsNumOpt, jsStr, jsx, normalizeText, runTp } from "./textPipelineShared.js";

// ─────────────────────────────────────────────────────────────────────────────
// ExtendScript core shared with template.ts (apply_template_content,
// duplicate_page_with_content) and text.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const REPLACE_PARAGRAPHS_JSX = jsx`
function __tp_trunc(s, n) { s = __tp_str(s); return s.length > n ? s.substring(0, n) + '...' : s; }
// Index of the label colon in txt[from, to): first ':' that is not part of
// http(s):// and not between two digits (times like 10:30).
function __tp_labelColon(txt, from, to) {
  for (var i = from; i < to; i++) {
    if (txt.charAt(i) !== ':') continue;
    var before = txt.substring(Math.max(from, i - 5), i).toLowerCase();
    if (/https?$/.test(before) && txt.substr(i + 1, 2) === '//') continue;
    if (i > from && /\d/.test(txt.charAt(i - 1)) && i + 1 < to && /\d/.test(txt.charAt(i + 1))) continue;
    return i;
  }
  return -1;
}
function __tp_inspectParagraph(p, keepLeading) {
  var info = { error: null };
  info.pStart = p.insertionPoints[0].index;
  info.pEnd = p.insertionPoints[-1].index;
  info.txt = __tp_str(p.contents);
  if (info.txt.length !== info.pEnd - info.pStart) {
    info.error = 'paragraph text length ' + info.txt.length + ' differs from its character span ' + (info.pEnd - info.pStart) + ' (special characters such as page-number markers); not editable safely';
    return info;
  }
  info.hasCR = info.txt.length > 0 && info.txt.charAt(info.txt.length - 1) === '\r';
  info.bodyEnd = info.hasCR ? info.txt.length - 1 : info.txt.length;
  var pre = 0;
  if (keepLeading) {
    while (pre < info.bodyEnd) { var c = info.txt.charAt(pre); if (c === '￼' || c === '\t') pre++; else break; }
  }
  info.pre = pre;
  info.style = p.appliedParagraphStyle;
  info.styleId = info.style.id;
  info.styleName = __tp_stylePath(info.style);
  return info;
}
function __tp_runAt(runs, off) {
  for (var i = 0; i < runs.length; i++) { if (off >= runs[i].start && off < runs[i].endExclusive) return runs[i]; }
  return null;
}

// ── GREP / nested styles ────────────────────────────────────────────────────
function __sc_csFontStyle(cs) { try { var f = cs.fontStyle; return typeof f === 'string' ? f : null; } catch (e) { return null; } }
// GREP and nested styles of a paragraph or paragraph style (JSON-safe summary).
function __sc_styleRules(obj) {
  var out = { grepStyles: [], nestedStyles: [] };
  try {
    var g = obj.nestedGrepStyles;
    for (var i = 0; i < g.length; i++) {
      var cs = null; try { cs = g[i].appliedCharacterStyle; } catch (e1) {}
      out.grepStyles.push({ grepExpression: __tp_str(g[i].grepExpression), characterStyle: __tp_name(cs), characterFontStyle: __sc_csFontStyle(cs) });
    }
  } catch (e) {}
  try {
    var ns = obj.nestedStyles;
    for (var j = 0; j < ns.length; j++) {
      var c2 = null; try { c2 = ns[j].appliedCharacterStyle; } catch (e2) {}
      var d = null; try { d = ns[j].delimiter; } catch (e3) {}
      var rep = null; try { rep = ns[j].repetition; } catch (e4) {}
      var inc = null; try { inc = ns[j].inclusive; } catch (e5) {}
      out.nestedStyles.push({ delimiter: typeof d === 'string' ? d : __tp_str(d), delimiterIsText: typeof d === 'string', repetition: rep, inclusive: inc, characterStyle: __tp_name(c2), characterFontStyle: __sc_csFontStyle(c2) });
    }
  } catch (e6) {}
  return out;
}
// True when a GREP expression matches/looks behind a literal ':' (ignores the
// ':' of group syntax such as (?: and (?<= ).
function __sc_exprHasColon(ex) { return /:/.test(String(ex).replace(/\(\?<?[=!:]/g, '(').replace(/\(\?[imsx-]+:?/g, '(')); }
// The GREP / nested style rules of obj that key on ':' (they format text up to a colon).
function __sc_colonRules(obj) {
  var r = __sc_styleRules(obj), out = [];
  for (var i = 0; i < r.grepStyles.length; i++) if (__sc_exprHasColon(r.grepStyles[i].grepExpression)) out.push({ kind: 'grep', grepExpression: r.grepStyles[i].grepExpression, characterStyle: r.grepStyles[i].characterStyle, characterFontStyle: r.grepStyles[i].characterFontStyle });
  for (var j = 0; j < r.nestedStyles.length; j++) if (r.nestedStyles[j].delimiterIsText && r.nestedStyles[j].delimiter.indexOf(':') >= 0) out.push({ kind: 'nested', delimiter: r.nestedStyles[j].delimiter, characterStyle: r.nestedStyles[j].characterStyle, characterFontStyle: r.nestedStyles[j].characterFontStyle });
  return out;
}
// Colon rules for a paragraph: its own (local + inherited) rules, else its style's.
function __sc_paraColonRules(p, style) {
  var r = __sc_colonRules(p);
  if (!r.length && style) r = __sc_colonRules(style);
  return r;
}
// Guard: new text that contains ':' where the template text had none, written
// into a paragraph whose GREP/nested style keys on ':', would be re-formatted
// (typically bold up to the last colon). Returns null or {err, extra}.
// With accept === true, returns null and stores a warning on holder.grepWarning.
// A GREP rule that formats greedily up to the LAST ':' (e.g. '.+(?<=:)' or '.*:'):
// a '.+' / '.*' that is not lazy. Nested styles stop at the first delimiter.
// Only a rule whose ':' comes AFTER the greedy run (e.g. '.+(?<=:)', '^.*:') runs
// to the last colon; '(?=:).+' starts at the FIRST colon and is not greedy-to-last (r4-B3).
function __sc_colonAfterGreedy(ex) {
  ex = String(ex);
  var m = /\.[+*](?!\?)/.exec(ex);
  if (!m) return false;
  return ex.indexOf(':', m.index + 2) >= 0;
}
function __sc_greedyColonRule(rules) {
  for (var i = 0; i < rules.length; i++) if (rules[i].kind === 'grep' && __sc_colonAfterGreedy(rules[i].grepExpression)) return rules[i];
  return null;
}
// How a ':'-keyed rule spans the text, for messages.
function __sc_colonRuleSpan(r) {
  if (r.kind !== 'grep') return 'up to and including the first ":" (nested style delimiter ' + r.delimiter + ')';
  var ex = String(r.grepExpression), m = /\.[+*]/.exec(ex), c = ex.indexOf(':');
  if (m && c >= 0 && c < m.index) return 'from the first ":" on (GREP ' + ex + ')';
  if (__sc_colonAfterGreedy(ex)) return 'up to and including the LAST ":" (GREP ' + ex + ')';
  return 'up to ":" (GREP ' + ex + ')';
}
// Also (design-r3-04): new text with 2+ ':' (where the template text has fewer
// than 2) under a greedy ':' GREP would be formatted up to its LAST colon, so
// part of the value after the first ':' (the label) would be bold as well.
function __sc_grepGuard(rulesSrc, styleForFallback, styleName, oldText, newText, accept, holder) {
  newText = __tp_str(newText); oldText = __tp_str(oldText);
  var nNew = __tp_count(newText, ':'), nOld = __tp_count(oldText, ':');
  if (nNew === 0) return null;
  // GREP styles work per paragraph: count colons per resulting paragraph (r4-B3),
  // so 4 paragraphs joined with \r with one ':' each are not "4 colons".
  var pieces = newText.split('\r'), mpi = 0, nMax = 0;
  for (var pc = 0; pc < pieces.length; pc++) { var cc = __tp_count(pieces[pc], ':'); if (cc > nMax) { nMax = cc; mpi = pc; } }
  var noColonTpl = nOld === 0, multi = nMax >= 2 && nOld < 2;
  if (!noColonTpl && !multi) return null;
  var rules = __sc_paraColonRules(rulesSrc, styleForFallback);
  if (!rules.length) return null;
  var greedy = multi ? __sc_greedyColonRule(rules) : null;
  if (!noColonTpl && !greedy) return null;
  var r0 = greedy || rules[0];
  var extra = { rules: rules, newText: __tp_trunc(newText, 120), templateText: __tp_trunc(oldText, 120) };
  var msg = '';
  if (noColonTpl) {
    msg = 'GREP/nested style of ' + styleName + ' would apply character style ' + (r0.characterStyle || '?') + (r0.characterFontStyle ? ' (' + r0.characterFontStyle + ')' : '') +
      ' to the new text ' + __sc_colonRuleSpan(r0) + '; the template text has no ":"';
  }
  if (greedy) {
    var mt = pieces[mpi];
    var c1 = mt.indexOf(':'), cN = mt.lastIndexOf(':');
    var label = mt.substring(0, c1 + 1), boldRun = mt.substring(0, cN + 1), valueBold = mt.substring(c1 + 1, cN + 1).replace(/^\s+/, '');
    extra.multiColon = { colonCount: nMax, paragraphOfEdit: pieces.length > 1 ? mpi : null, label: __tp_trunc(label, 60), boldRun: __tp_trunc(boldRun, 120), valuePartBold: __tp_trunc(valueBold, 120), grepExpression: greedy.grepExpression, characterStyle: greedy.characterStyle };
    msg += (msg ? '; also: ' : '') + 'the text "' + __tp_trunc(mt, 80) + '"' + (pieces.length > 1 ? ' (paragraph ' + mpi + ' of the edit)' : '') + ' contains ' + nMax + ' ":" and GREP ' + greedy.grepExpression + ' of ' + styleName +
      ' applies ' + (greedy.characterStyle || '?') + (greedy.characterFontStyle ? ' (' + greedy.characterFontStyle + ')' : '') + ' up to the LAST ":", so the value part "' + __tp_trunc(valueBold, 80) +
      '" would be bold too, not only the label "' + __tp_trunc(label, 60) + '" (rule: bold up to and including the first colon, then roman)';
  }
  if (accept) { holder.grepWarning = msg + ' (written because acceptGrepEffects:true)'; if (extra.multiColon) holder.grepMultiColon = extra.multiColon; return null; }
  return { err: msg + '. Nothing written. Pass acceptGrepEffects:true to accept that formatting, or remove the extra ":" (e.g. a "https://" scheme, a "Label:" prefix or a time such as "10:00") as your own decision',
           extra: extra };
}

// ── numbering ───────────────────────────────────────────────────────────────
function __sc_isNumbered(p) { try { return p.bulletsAndNumberingListType === ListType.NUMBERED_LIST; } catch (e) { return false; } }
function __sc_numVal(t) { var m = /(\d+)/.exec(__tp_str(t)); return m ? parseInt(m[1], 10) : null; }
// Numbered paragraphs from index 'from' on (max maxNum, scanning at most maxScan paragraphs).
function __sc_numberingSnap(story, from, maxNum, maxScan) {
  var out = [], total = story.paragraphs.length;
  for (var q = Math.max(0, from); q < total && q < from + maxScan && out.length < maxNum; q++) {
    var p = story.paragraphs[q];
    if (!__sc_isNumbered(p)) continue;
    var rt = null; try { rt = __tp_str(p.bulletsAndNumberingResultText); } catch (e) {}
    var nc = null; try { nc = p.numberingContinue; } catch (e2) {}
    var lk = null; try { lk = __sc_key(p.appliedNumberingList); } catch (e3) {}
    out.push({ pi: q, text: rt, restart: nc === false, listKey: lk, excerpt: __tp_trunc(p.contents, 40) });
  }
  return out;
}

// ── spacing of the paragraph that follows an inserted / restyled block ──────
function __sc_nextSpacing(story, idx) {
  var total = story.paragraphs.length;
  if (idx <= 0 || idx >= total) return null;
  var q = story.paragraphs[idx], prev = story.paragraphs[idx - 1];
  var o = { para: q };
  try { o.style = __tp_stylePath(q.appliedParagraphStyle); } catch (e) { o.style = '?'; }
  o.text = __tp_trunc(q.contents, 60);
  try { o.spaceBefore = q.spaceBefore; o.styleSpaceBefore = q.appliedParagraphStyle.spaceBefore; } catch (e2) {}
  try { o.prevStyle = __tp_stylePath(prev.appliedParagraphStyle); o.prevSpaceAfter = prev.spaceAfter; o.prevStyleSpaceAfter = prev.appliedParagraphStyle.spaceAfter; } catch (e3) {}
  o.beforeOverridden = typeof o.spaceBefore === 'number' && typeof o.styleSpaceBefore === 'number' && Math.abs(o.spaceBefore - o.styleSpaceBefore) > 0.001;
  o.prevAfterOverridden = typeof o.prevSpaceAfter === 'number' && typeof o.prevStyleSpaceAfter === 'number' && Math.abs(o.prevSpaceAfter - o.prevStyleSpaceAfter) > 0.001;
  return o;
}
// Inspect (and with reset, fix spaceBefore of) the paragraph at idx; returns a JSON-safe record or null.
function __sc_checkNextSpacing(story, idx, reset, entry) {
  var o = __sc_nextSpacing(story, idx);
  if (!o) return null;
  var rec = { text: o.text, style: o.style, spaceBefore: typeof o.spaceBefore === 'number' ? __tp_round(o.spaceBefore) : null, styleSpaceBefore: typeof o.styleSpaceBefore === 'number' ? __tp_round(o.styleSpaceBefore) : null,
              beforeOverridden: o.beforeOverridden, prevStyle: o.prevStyle, prevSpaceAfter: typeof o.prevSpaceAfter === 'number' ? __tp_round(o.prevSpaceAfter) : null,
              prevStyleSpaceAfter: typeof o.prevStyleSpaceAfter === 'number' ? __tp_round(o.prevStyleSpaceAfter) : null, prevAfterOverridden: o.prevAfterOverridden };
  if (reset && o.beforeOverridden) {
    try {
      o.para.spaceBefore = o.styleSpaceBefore;
      entry.spacingReset = { text: o.text, style: o.style, property: 'spaceBefore', from: rec.spaceBefore, to: rec.styleSpaceBefore };
      rec.reset = true;
    } catch (eR) { rec.resetError = String(eR); }
  }
  entry.nextParagraph = rec;
  return rec;
}
function __sc_spacingWarning(n, rec, editIdx, indexNote) {
  var w = [];
  if (rec.beforeOverridden && !rec.reset) w.push('paragraph ' + n + indexNote + ' (style ' + rec.style + ', "' + rec.text + '") keeps local spaceBefore ' + rec.spaceBefore + ' pt (style value ' + rec.styleSpaceBefore + ' pt) that was set for its previous neighbour; gap may be wrong (resetNextSpacing:true on edit ' + editIdx + ' uses the style value)');
  if (rec.prevAfterOverridden) w.push('paragraph before paragraph ' + n + indexNote + ' (style ' + rec.prevStyle + ') has local spaceAfter ' + rec.prevSpaceAfter + ' pt (style value ' + rec.prevStyleSpaceAfter + ' pt); gap to paragraph ' + n + ' may be wrong (not changed)');
  return w;
}

// ── tables in a paragraph ───────────────────────────────────────────────────
function __sc_tableInfo(p) {
  var out = [], tabs = null;
  try { tabs = p.tables; } catch (e) { return out; }
  for (var t = 0; t < tabs.length; t++) {
    var tb = tabs[t], o = {};
    try { o.tableId = tb.id; } catch (e0) {}
    try { o.rows = tb.rows.length; } catch (e1) {}
    try { o.columns = tb.columns.length; } catch (e2) {}
    try { o.cellCount = tb.cells.length; } catch (e3) {}
    try { o.firstCellExcerpt = __tp_trunc(tb.cells[0].contents, 60); } catch (e4) { o.firstCellExcerpt = null; }
    var anch = 0, nested = 0;
    try {
      var cc = __tp_arr(tb.cells.everyItem().contents);
      for (var c = 0; c < cc.length; c++) { var cs = __tp_str(cc[c]); anch += __tp_count(cs, '￼'); nested += __tp_count(cs, '\u0016'); }
    } catch (e5) { o.cellScanFailed = true; }
    o.anchoredObjectsInCells = anch;
    o.nestedTables = nested;
    out.push(o);
  }
  return out;
}

// ── paragraph-level override snapshot / restore ─────────────────────────────
// Order matters on restore: the list type first, then the list, then numbering.
var __SC_PARA_PROPS = ['bulletsAndNumberingListType', 'appliedNumberingList', 'numberingFormat', 'numberingLevel',
  'numberingContinue', 'numberingStartAt', 'leftIndent', 'firstLineIndent', 'spaceBefore', 'spaceAfter',
  'keepWithNext', 'startParagraph'];
// Properties only the FIRST paragraph of a split keeps; followers take the style value.
var __SC_FIRST_ONLY = ['numberingContinue', 'numberingStartAt', 'startParagraph'];
var __SC_CHAR_PROPS = ['appliedCharacterStyle', 'appliedFont', 'fontStyle', 'pointSize', 'leading', 'fillColor', 'fillTint',
  'strokeColor', 'strokeWeight', 'tracking', 'horizontalScale', 'verticalScale', 'baselineShift', 'capitalization',
  'position', 'underline', 'strikeThru', 'ligatures', 'noBreak'];
function __sc_key(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'n:' + (Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return 'b:' + v;
  if (typeof v === 'string') return 's:' + v;
  try { if (v.id !== undefined && v.id !== null) return 'o:' + v.id; } catch (e) {}
  try { if (v.name !== undefined && v.name !== null) return 'o:' + v.name; } catch (e2) {}
  try { return 'x:' + String(v); } catch (e3) { return 'x:?'; }
}
function __sc_show(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  try { if (v.name !== undefined && v.name !== null) return String(v.name); } catch (e) {}
  try { return String(v); } catch (e2) { return '?'; }
}
function __sc_snap(p) {
  var s = {};
  for (var i = 0; i < __SC_PARA_PROPS.length; i++) { var k = __SC_PARA_PROPS[i]; try { s[k] = p[k]; } catch (e) {} }
  return s;
}
// Names of the snapshot properties that differ from the paragraph style (= local overrides).
function __sc_overrides(snap, style) {
  var out = [];
  for (var i = 0; i < __SC_PARA_PROPS.length; i++) {
    var k = __SC_PARA_PROPS[i];
    if (!snap.hasOwnProperty(k)) continue;
    var sv; try { sv = style[k]; } catch (e) { continue; }
    if (__sc_key(snap[k]) !== __sc_key(sv)) out.push(k);
  }
  return out;
}
// Snapshot for paragraphs created by splitting p: same overrides, except the
// first-only properties, which get the style value.
function __sc_followerWant(snap, style) {
  var w = {};
  for (var k in snap) if (snap.hasOwnProperty(k)) w[k] = snap[k];
  for (var i = 0; i < __SC_FIRST_ONLY.length; i++) {
    var f = __SC_FIRST_ONLY[i];
    try { w[f] = style[f]; } catch (e) { delete w[f]; }
  }
  return w;
}
function __sc_restore(p, want) {
  for (var i = 0; i < __SC_PARA_PROPS.length; i++) {
    var k = __SC_PARA_PROPS[i];
    if (!want.hasOwnProperty(k)) continue;
    try { if (__sc_key(p[k]) !== __sc_key(want[k])) p[k] = want[k]; } catch (e) {}
  }
}
function __sc_verify(p, want, pi, res, role) {
  for (var i = 0; i < __SC_PARA_PROPS.length; i++) {
    var k = __SC_PARA_PROPS[i];
    if (!want.hasOwnProperty(k)) continue;
    var cur; try { cur = p[k]; } catch (e) { continue; }
    if (__sc_key(cur) !== __sc_key(want[k])) res.overrideErrors.push({ paragraphIndex: pi, role: role, property: k, expected: __sc_show(want[k]), actual: __sc_show(cur) });
  }
}
function __sc_ensureStyle(p, style) {
  var id = -1; try { id = p.appliedParagraphStyle.id; } catch (e) {}
  if (id !== style.id) { try { p.applyParagraphStyle(style, false); } catch (e2) {} }
}
function __sc_restyle(p, style) {
  try { p.applyParagraphStyle(style, false); } catch (e) {}
  try { p.clearOverrides(OverrideType.PARAGRAPH_ONLY); } catch (e2) {}
}
function __sc_copyFmt(src, dst) {
  for (var i = 0; i < __SC_CHAR_PROPS.length; i++) { var k = __SC_CHAR_PROPS[i]; try { dst[k] = src[k]; } catch (e) {} }
}

// ── text writing that never replaces the paragraph's first character ────────
// Inserts text at story insertion point pos (a lone '\n' becomes a forced line
// break). The text takes the formatting of the character before pos.
function __sc_insertAt(story, pos, text) {
  var parts = String(text).split('\n');
  for (var k = 0; k < parts.length; k++) {
    if (k > 0) { story.insertionPoints[pos].contents = SpecialCharacters.FORCED_LINE_BREAK; pos += 1; }
    if (parts[k].length) { story.insertionPoints[pos].contents = parts[k]; pos += parts[k].length; }
  }
  return pos;
}
function __sc_removeRange(story, a, bIncl) {
  if (bIncl < a) return;
  var r = story.characters.itemByRange(a, bIncl);
  try { r.remove(); } catch (e) { r.contents = ''; }
}
// Replace story range [a, bExcl) with text. The new text is inserted AFTER the
// first old character (so it inherits that character's formatting), then the
// old text is removed. The range is never assigned as a whole, so the paragraph
// object (and its attributes) is never rebuilt. Returns the index after the text.
function __sc_writePreservingPara(story, a, bExcl, text) {
  if (bExcl <= a) return __sc_insertAt(story, a, text);
  var end = __sc_insertAt(story, a + 1, text);
  var L = end - (a + 1);
  if (bExcl - 1 > a) __sc_removeRange(story, a + 1 + L, bExcl + L - 1);
  __sc_removeRange(story, a, a);
  return a + L;
}

// ── edit planning ───────────────────────────────────────────────────────────
function __sc_given(v) { return v !== null && v !== undefined; }
function __sc_kind(ed) {
  var del = ed['delete'] === true, ins = ed.insertAfter === true;
  if (del && ins) return { error: 'give delete or insertAfter, not both' };
  if (del) return { kind: 'delete', phase: 2 };
  if (ins) return { kind: 'insert', phase: 0 };
  return { kind: 'replace', phase: 1 };
}
function __sc_targetStyle(doc, ed) {
  var ref = null;
  if (__sc_given(ed.styleId)) ref = Number(ed.styleId);
  else if (__sc_given(ed.styleName) && String(ed.styleName) !== '') ref = String(ed.styleName);
  if (ref === null) return { style: null };
  try {
    var st = __tp_findStyle(doc, 'paragraph', ref);
    if (!st) return { error: 'paragraph style not found: ' + ref };
    return { style: st };
  } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
}
// Label/value structure of a template paragraph: bold/medium run up to ':' and a value run after it.
function __sc_lvPlan(p, info) {
  var colon = __tp_labelColon(info.txt, info.pre, info.bodyEnd);
  if (colon <= info.pre) return { error: 'label requested but the template paragraph has no "Label:" run' };
  // Effective (rendered) formatting: GREP / nested styles included. The raw
  // text-style ranges are reported alongside for comparison.
  var runs = __tp_effectiveRuns(p, info.pStart, info.pEnd, false);
  var raw = null; try { raw = __tp_runs(p, info.pStart, info.pEnd, false); } catch (eR) { raw = null; }
  var r0 = __tp_runAt(runs, info.pre);
  var rr0 = raw ? __tp_runAt(raw, info.pre) : null;
  if (!r0 || !(r0.bold || r0.medium)) return { error: 'label requested but the run before ":" is not bold/medium', extra: { fontStyle: r0 ? r0.fontStyle : null, rawFontStyle: rr0 ? rr0.fontStyle : null } };
  // A bold run ending exactly AT the colon is valid (the colon then belongs to
  // the value run, e.g. a GREP style that starts at ':').
  if (r0.endExclusive < colon) return { error: 'bold run ends before the colon; label boundary is ambiguous', extra: { boldEndsAt: r0.endExclusive, colonAt: colon } };
  var vs = colon + 1;
  while (vs < info.bodyEnd) { var cv = info.txt.charAt(vs); if (cv === ' ' || cv === '\t' || cv === ' ') vs++; else break; }
  var vr = __tp_runAt(runs, vs);
  var rvr = raw ? __tp_runAt(raw, vs) : null;
  return { colon: colon, valueStart: vs, labelFontStyle: r0.fontStyle, valueFontStyle: vr ? vr.fontStyle : null,
           labelFontStyleRaw: rr0 ? rr0.fontStyle : null, valueFontStyleRaw: rvr ? rvr.fontStyle : null, runsSource: 'effective' };
}
// Read-only validation of one edit against the CURRENT story. Returns {err, extra} or a plan.
function __sc_plan(doc, story, it, keepLeading, opts) {
  var ed = it.e, pi = it.pi, n = story.paragraphs.length;
  if (pi < 0 || pi >= n) return { err: 'paragraph missing (story has ' + n + ' paragraphs)' };
  var p = story.paragraphs[pi];
  var info = __tp_inspectParagraph(p, keepLeading);
  if (info.error) return { err: info.error };
  if (__sc_given(ed.expectStyleId) && Number(ed.expectStyleId) !== info.styleId) {
    return { err: 'paragraph style differs from expectStyleId', extra: { expectStyleId: ed.expectStyleId, actualStyleId: info.styleId, actualStyle: info.styleName, text: __tp_trunc(info.txt, 120) } };
  }
  var hasLV = __sc_given(ed.label) || __sc_given(ed.value);
  var hasText = __sc_given(ed.text);
  var ts = __sc_targetStyle(doc, ed);
  if (ts.error) return { err: ts.error };
  var plan = { kind: it.kind, p: p, info: info, target: ts.style };
  plan.restyle = !!(ts.style && ts.style.id !== info.styleId);
  if (it.kind === 'delete') {
    if (hasLV || hasText || ts.style) return { err: 'a delete edit takes no text, label, value, styleId or styleName' };
    if (info.txt.indexOf('￼') >= 0) return { err: 'paragraph contains an anchored object (U+FFFC); deleting it would remove the object', extra: { text: __tp_trunc(info.txt, 120) } };
    var nt = 0; try { nt = p.tables.length; } catch (e) {}
    var hasTable = nt > 0 || info.txt.indexOf('\u0016') >= 0;
    var body = info.txt.substring(0, info.bodyEnd);
    var hasRows = __sc_given(ed.expectTableRows), hasCols = __sc_given(ed.expectTableColumns);
    if (hasTable) {
      var tinfo = __sc_tableInfo(p);
      if (ed.allowTable !== true) return { err: 'paragraph contains a table; not deleted (to delete it pass allowTable:true with expectText or expectTableRows/expectTableColumns)', extra: { text: __tp_trunc(info.txt, 120), tables: tinfo } };
      for (var tq = 0; tq < tinfo.length; tq++) {
        if (tinfo[tq].anchoredObjectsInCells > 0) return { err: 'table ' + tinfo[tq].tableId + ' has ' + tinfo[tq].anchoredObjectsInCells + ' anchored object(s) in its cells; deleting it would remove them; not deleted', extra: { tables: tinfo } };
        if (tinfo[tq].cellScanFailed) return { err: 'could not read the cells of table ' + tinfo[tq].tableId + ' to check for anchored objects; not deleted', extra: { tables: tinfo } };
      }
      var hasExp = __sc_given(ed.expectText) && String(ed.expectText) !== '';
      if (!hasExp && !hasRows && !hasCols) return { err: 'allowTable:true needs expectText (paragraph text or first-cell text) or expectTableRows/expectTableColumns to confirm the table', extra: { tables: tinfo, text: __tp_trunc(info.txt, 120) } };
      if (!tinfo.length && (hasRows || hasCols)) return { err: 'expectTableRows/expectTableColumns given but the table of this paragraph could not be read', extra: { text: __tp_trunc(info.txt, 120) } };
      for (var tr = 0; tr < tinfo.length; tr++) {
        if ((hasRows && tinfo[tr].rows !== Number(ed.expectTableRows)) || (hasCols && tinfo[tr].columns !== Number(ed.expectTableColumns))) {
          return { err: 'table dimensions differ from expectTableRows/expectTableColumns', extra: { expectTableRows: hasRows ? Number(ed.expectTableRows) : null, expectTableColumns: hasCols ? Number(ed.expectTableColumns) : null, tables: tinfo } };
        }
      }
      if (hasExp) {
        var et = String(ed.expectText), bodyNoTable = body.replace(/\u0016/g, '');
        var cellOk = false;
        for (var tc = 0; tc < tinfo.length && !cellOk; tc++) { try { cellOk = __tp_str(p.tables[tc].cells[0].contents).indexOf(et) === 0; } catch (eCt) {} }
        if (bodyNoTable.indexOf(et) !== 0 && !cellOk) return { err: 'neither the paragraph text nor the first cell of its table starts with expectText', extra: { expectText: et, text: __tp_trunc(bodyNoTable, 120), tables: tinfo } };
      }
      plan.tables = tinfo;
    } else {
      if (ed.allowTable === true || hasRows || hasCols) return { err: 'allowTable/expectTableRows/expectTableColumns given but the paragraph holds no table (wrong paragraphIndex?)', extra: { text: __tp_trunc(info.txt, 120) } };
      if (__sc_given(ed.expectText)) {
        if (body.indexOf(String(ed.expectText)) !== 0) return { err: 'paragraph text does not start with expectText', extra: { expectText: String(ed.expectText), text: __tp_trunc(info.txt, 120) } };
      }
    }
    if (ed.resetNextSpacing === true) return { err: 'resetNextSpacing is only used with insertAfter or a replace that changes the paragraph style' };
    if (n <= 1) return { err: 'cannot delete the only paragraph of the story' };
    return plan;
  }
  if (__sc_given(ed.expectText)) return { err: 'expectText is only used with delete:true (use expectStyleId to guard other edits)' };
  if (ed.allowTable === true || __sc_given(ed.expectTableRows) || __sc_given(ed.expectTableColumns)) return { err: 'allowTable/expectTableRows/expectTableColumns are only used with delete:true' };
  if (ed.resetNextSpacing === true && !(it.kind === 'insert' || (it.kind === 'replace' && plan.restyle))) return { err: 'resetNextSpacing is only used with insertAfter or a replace that changes the paragraph style (styleId/styleName)' };
  var acceptGrep = ed.acceptGrepEffects === true || !!(opts && opts.acceptGrepEffects === true);
  if (hasLV && hasText) return { err: 'give either text or label/value, not both' };
  if (!hasLV && !hasText) return { err: 'edit has no text, label or value' };
  plan.mode = hasLV ? 'labelValue' : 'text';
  var wantValue = __sc_given(ed.value) && String(ed.value) !== '';
  if (it.kind === 'replace') {
    var inner = info.txt.substring(info.pre, info.bodyEnd);
    if (inner.indexOf('￼') >= 0) return { err: 'paragraph contains an anchored object inside its text (not only as a leading prefix); replacing would delete it', extra: { text: __tp_trunc(info.txt, 120) } };
    if (inner.indexOf('\u0016') >= 0) return { err: 'paragraph contains a table; replacing its text would delete the table (delete it with {delete:true, allowTable:true, ...} if that is intended)', extra: { text: __tp_trunc(info.txt, 120) } };
    var gq;
    if (hasLV) {
      if (plan.restyle) return { err: 'styleId/styleName is supported on text edits only (restyling would clear the label/value formatting)' };
      var lv = __sc_lvPlan(p, info);
      if (lv.error) { var x1 = lv.extra || {}; x1.text = __tp_trunc(info.txt, 120); return { err: lv.error, extra: x1 }; }
      if (wantValue && lv.valueStart >= info.bodyEnd) return { err: 'template paragraph has no value run after the label (value would inherit the bold label formatting)', extra: { text: __tp_trunc(info.txt, 120) } };
      plan.lv = lv;
      if (__sc_given(ed.value)) gq = __sc_grepGuard(p, info.style, info.styleName, info.txt.substring(lv.valueStart, info.bodyEnd), ed.value, acceptGrep, plan);
    } else {
      gq = plan.restyle
        ? __sc_grepGuard(plan.target, null, __tp_stylePath(plan.target), inner, ed.text, acceptGrep, plan)
        : __sc_grepGuard(p, info.style, info.styleName, inner, ed.text, acceptGrep, plan);
    }
    if (gq) return gq;
    try { plan.lineCountBefore = p.lines.length; } catch (e2) { plan.lineCountBefore = null; }
    return plan;
  }
  // insertAfter
  if (hasLV) {
    if (plan.restyle) return { err: "a label/value insert copies the anchor paragraph's Label: value formatting, so it keeps the anchor style; use text + styleId to insert a paragraph in another style" };
    if (!__sc_given(ed.label)) return { err: 'a label/value insert needs a label' };
    var lv2 = __sc_lvPlan(p, info);
    if (lv2.error) { var x2 = lv2.extra || {}; x2.text = __tp_trunc(info.txt, 120); x2.note = 'the anchor paragraph is the formatting template of a label/value insert'; return { err: lv2.error, extra: x2 }; }
    if (wantValue && lv2.valueStart >= info.bodyEnd) return { err: 'anchor paragraph has no value run after its label to copy the value formatting from', extra: { text: __tp_trunc(info.txt, 120) } };
    plan.lv = lv2;
    if (__sc_given(ed.value)) {
      var gi = __sc_grepGuard(p, info.style, info.styleName, info.txt.substring(lv2.valueStart, info.bodyEnd), ed.value, acceptGrep, plan);
      if (gi) return gi;
    }
  } else {
    var anchorInner = info.txt.substring(info.pre, info.bodyEnd);
    var gt = plan.restyle
      ? __sc_grepGuard(plan.target, null, __tp_stylePath(plan.target), anchorInner, ed.text, acceptGrep, plan)
      : __sc_grepGuard(p, info.style, info.styleName, anchorInner, ed.text, acceptGrep, plan);
    if (gt) return gt;
  }
  return plan;
}

// ── edit application (each returns the paragraph-count delta) ───────────────
function __sc_doReplace(story, it, pl, res, entry) {
  var ed = it.e, info = pl.info, pi = it.pi;
  var snap = __sc_snap(pl.p);
  var ovr = __sc_overrides(snap, info.style);
  if (ovr.length) entry.paragraphOverrides = ovr;
  var added = 0, wEnd = info.pStart + info.pre;
  if (pl.mode === 'labelValue') {
    if (__sc_given(ed.value)) {
      var v = String(ed.value);
      __sc_writePreservingPara(story, info.pStart + pl.lv.valueStart, info.pStart + info.bodyEnd, v);
      added += __tp_count(v, '\r');
    }
    if (__sc_given(ed.label)) {
      var lab = String(ed.label).replace(/\s*:\s*$/, '');
      __sc_writePreservingPara(story, info.pStart + info.pre, info.pStart + pl.lv.colon, lab);
      added += __tp_count(lab, '\r');
    }
  } else {
    var t = String(ed.text);
    wEnd = __sc_writePreservingPara(story, info.pStart + info.pre, info.pStart + info.bodyEnd, t);
    added += __tp_count(t, '\r');
  }
  var j;
  if (pl.restyle) {
    for (j = 0; j <= added; j++) __sc_restyle(story.paragraphs[pi + j], pl.target);
    try { if (wEnd > info.pStart + info.pre) story.characters.itemByRange(info.pStart + info.pre, wEnd - 1).clearOverrides(OverrideType.CHARACTER_ONLY); } catch (eC) {}
    entry.restyled = true;
    if (ovr.length) entry.overridesCleared = ovr;
  } else {
    var p2 = story.paragraphs[pi];
    __sc_ensureStyle(p2, info.style);
    __sc_restore(p2, snap);
    __sc_verify(p2, snap, pi, res, 'edited');
    if (added) {
      var fw = __sc_followerWant(snap, info.style);
      for (j = 1; j <= added; j++) {
        var q = story.paragraphs[pi + j];
        __sc_ensureStyle(q, info.style);
        __sc_restore(q, fw);
        __sc_verify(q, fw, pi + j, res, 'added');
      }
    }
  }
  var wantId = pl.restyle ? pl.target.id : info.styleId;
  var numNow = 0;
  for (j = 0; j <= added; j++) {
    var aid = -1; try { aid = story.paragraphs[pi + j].appliedParagraphStyle.id; } catch (e2) {}
    if (aid !== wantId) res.styleErrors.push({ paragraphIndex: pi + j, expected: wantId, actual: aid });
    if (__sc_isNumbered(story.paragraphs[pi + j])) numNow++;
  }
  // Numbered-paragraph count change (used by the list-numbering check).
  it.numDelta = numNow - (snap.bulletsAndNumberingListType === ListType.NUMBERED_LIST ? 1 : 0);
  it.listKey = __sc_key(snap.appliedNumberingList);
  // A restyled paragraph changes the gap to the paragraph that follows it.
  if (pl.restyle) it.nextSpacing = __sc_checkNextSpacing(story, pi + added + 1, it.e.resetNextSpacing === true, entry);
  entry.after = __tp_trunc(story.paragraphs[pi].contents, 200);
  if (added) entry.paragraphsAdded = added;
  return added;
}
function __sc_doInsert(story, it, pl, res, entry) {
  var ed = it.e, info = pl.info, pi = it.pi;
  var snap = __sc_snap(pl.p);
  // Split the anchor just before its own return: anchor body + NEW \r + inserted
  // text + the anchor's original \r. Both halves keep the anchor's attributes.
  var pos0 = info.pStart + info.bodyEnd;
  var p1 = __sc_insertAt(story, pos0, '\r');
  var txt, end;
  if (pl.mode === 'labelValue') {
    var lab = String(ed.label).replace(/\s*:\s*$/, '');
    var mid = info.txt.substring(pl.lv.colon, pl.lv.valueStart);
    var val = __sc_given(ed.value) ? String(ed.value) : '';
    var labEnd = __sc_insertAt(story, p1, lab);
    var midEnd = __sc_insertAt(story, labEnd, mid);
    end = __sc_insertAt(story, midEnd, val);
    txt = lab + mid + val;
    // Template characters are before pos0, so their indexes did not move.
    var cLab = story.characters[info.pStart + info.pre];
    var cCol = story.characters[info.pStart + pl.lv.colon];
    var cSep = pl.lv.valueStart > pl.lv.colon + 1 ? story.characters[info.pStart + pl.lv.colon + 1] : cCol;
    var cVal = pl.lv.valueStart < info.bodyEnd ? story.characters[info.pStart + pl.lv.valueStart] : cCol;
    if (labEnd > p1) __sc_copyFmt(cLab, story.characters.itemByRange(p1, labEnd - 1));
    if (midEnd > labEnd) {
      __sc_copyFmt(cCol, story.characters.itemByRange(labEnd, labEnd));
      if (midEnd - 1 > labEnd) __sc_copyFmt(cSep, story.characters.itemByRange(labEnd + 1, midEnd - 1));
    }
    if (end > midEnd) __sc_copyFmt(cVal, story.characters.itemByRange(midEnd, end - 1));
  } else {
    txt = String(ed.text);
    end = __sc_insertAt(story, p1, txt);
  }
  var size = 1 + __tp_count(txt, '\r');
  var pa = story.paragraphs[pi];
  __sc_ensureStyle(pa, info.style);
  __sc_restore(pa, snap);
  __sc_verify(pa, snap, pi, res, 'anchor');
  var fw = __sc_followerWant(snap, info.style);
  var wantId = pl.restyle ? pl.target.id : info.styleId;
  var numNew = 0;
  for (var j = 1; j <= size; j++) {
    var q = story.paragraphs[pi + j];
    if (pl.restyle) __sc_restyle(q, pl.target);
    else { __sc_ensureStyle(q, info.style); __sc_restore(q, fw); __sc_verify(q, fw, pi + j, res, 'inserted'); }
    var qid = -1; try { qid = q.appliedParagraphStyle.id; } catch (e) {}
    if (qid !== wantId) res.styleErrors.push({ paragraphIndex: pi + j, expected: wantId, actual: qid });
    if (__sc_isNumbered(q)) numNew++;
  }
  if (pl.restyle) { try { if (end > p1) story.characters.itemByRange(p1, end - 1).clearOverrides(OverrideType.CHARACTER_ONLY); } catch (eC) {} entry.restyled = true; }
  it.numDelta = numNew;
  it.listKey = __sc_key(snap.appliedNumberingList);
  // The paragraph that now FOLLOWS the inserted block keeps spacing overrides
  // tuned for its old neighbour (only checked for the insert that ends the block).
  if (it.checkNext) it.nextSpacing = __sc_checkNextSpacing(story, pi + size + 1, ed.resetNextSpacing === true, entry);
  entry.after = __tp_trunc(story.paragraphs[pi + 1].contents, 200);
  entry.paragraphsInserted = size;
  return size;
}
function __sc_doDelete(story, it, pl, res, entry) {
  var info = pl.info, pi = it.pi, a, b, nbBefore, nbAfter;
  if (info.hasCR) { a = info.pStart; b = info.pEnd - 1; nbBefore = pi + 1; nbAfter = pi; }
  else { a = info.pStart - 1; b = info.pEnd - 1; nbBefore = pi - 1; nbAfter = pi - 1; } // last paragraph: take the previous return with it
  var total = story.paragraphs.length, nbSnap = null, nbStyle = null;
  if (nbBefore >= 0 && nbBefore < total) {
    var nb = story.paragraphs[nbBefore];
    nbSnap = __sc_snap(nb);
    try { nbStyle = nb.appliedParagraphStyle; } catch (e) {}
  }
  // List restart carried by the deleted paragraph (numberingContinue=false /
  // its own numberingStartAt): it must move to the numbered paragraph that
  // follows, or the remaining items continue the previous list.
  var dp = pl.p, dNum = __sc_isNumbered(dp), restart = null, dList = null;
  try { dList = dp.appliedNumberingList; } catch (eL) {}
  if (dNum) {
    var dc = null, ds = null, sStart = null;
    try { dc = dp.numberingContinue; } catch (e1) {}
    try { ds = dp.numberingStartAt; } catch (e2) {}
    try { sStart = info.style.numberingStartAt; } catch (e3) {}
    if (dc === false || (typeof ds === 'number' && typeof sStart === 'number' && ds !== sStart)) restart = { numberingContinue: dc, numberingStartAt: ds };
  }
  entry.wasNumbered = dNum;
  it.numDelta = dNum ? -1 : 0;
  it.listKey = __sc_key(dList);
  var nbWant = nbSnap, moved = null;
  if (restart && info.hasCR && nbSnap && nbSnap.bulletsAndNumberingListType === ListType.NUMBERED_LIST &&
      ((nbStyle && nbStyle.id === info.styleId) || __sc_key(nbSnap.appliedNumberingList) === __sc_key(dList))) {
    if (__sc_key(nbSnap.numberingContinue) !== __sc_key(restart.numberingContinue) || __sc_key(nbSnap.numberingStartAt) !== __sc_key(restart.numberingStartAt)) {
      nbWant = {};
      for (var kw in nbSnap) if (nbSnap.hasOwnProperty(kw)) nbWant[kw] = nbSnap[kw];
      nbWant.numberingContinue = restart.numberingContinue;
      nbWant.numberingStartAt = restart.numberingStartAt;
      moved = { numberingContinue: __sc_show(restart.numberingContinue), numberingStartAt: __sc_show(restart.numberingStartAt),
                previous: { numberingContinue: __sc_show(nbSnap.numberingContinue), numberingStartAt: __sc_show(nbSnap.numberingStartAt) } };
    }
  } else if (restart) {
    entry.numberingRestartNotMoved = 'the deleted paragraph restarted its list but no numbered paragraph of the same style/list follows it';
  }
  __sc_removeRange(story, a, b);
  if (nbSnap && nbAfter >= 0 && nbAfter < story.paragraphs.length) {
    var q = story.paragraphs[nbAfter];
    if (nbStyle) __sc_ensureStyle(q, nbStyle);
    __sc_restore(q, nbWant);
    __sc_verify(q, nbWant, nbAfter, res, moved ? 'neighbour (list restart moved)' : 'neighbour');
    if (moved) {
      moved.text = __tp_trunc(q.contents, 60);
      try { moved.resultText = __tp_str(q.bulletsAndNumberingResultText); } catch (eR) {}
      entry.numberingRestartMovedTo = moved;
    }
  }
  entry.removedCharacters = b - a + 1;
  if (pl.tables) entry.tablesDeleted = pl.tables;
  return -1;
}

// Plan + apply edits to a story, last-to-first. edits:
//   {paragraphIndex, text | label/value, styleId?|styleName?, expectStyleId?}      replace
//   {paragraphIndex, delete:true, expectText?, expectStyleId?,
//    allowTable?, expectTableRows?, expectTableColumns?}                             delete
//   {paragraphIndex, insertAfter:true, text | label/value, styleId?|styleName?}      insert after
//   any text edit: acceptGrepEffects?; insert / restyling replace: resetNextSpacing?
// All paragraphIndex values refer to the story BEFORE this call. If any edit for
// a paragraph does not validate, or edits for one paragraph conflict (replace +
// delete, duplicate), no edit for that paragraph is applied.
function __tp_replaceParagraphs(doc, story, edits, opts) {
  var keepLeading = opts.keepLeadingAnchors !== false;
  var res = { storyId: story.id, applied: [], mismatches: [], styleErrors: [], overrideErrors: [], warnings: [], newOverset: [] };
  res.anchorsBefore = __tp_anchorCount(story);
  var n = story.paragraphs.length;
  res.paragraphCount = n;
  try { res.storyOverflowsBefore = story.overflows; } catch (eo) { res.storyOverflowsBefore = null; }
  var list = [], seen = {}, conflict = {};
  for (var i = 0; i < edits.length; i++) {
    var e = edits[i];
    if (!e || typeof e !== 'object') { res.mismatches.push({ edit: i, reason: 'edit must be an object' }); continue; }
    var pi = Number(e.paragraphIndex);
    if (isNaN(pi) || Math.floor(pi) !== pi) { res.mismatches.push({ edit: i, paragraphIndex: e.paragraphIndex, reason: 'paragraphIndex must be an integer' }); continue; }
    var kd = __sc_kind(e);
    if (kd.error) { res.mismatches.push({ edit: i, paragraphIndex: pi, reason: kd.error }); continue; }
    if (kd.kind !== 'insert') {
      // A conflict blocks EVERY edit of this paragraph (also the ones already
      // collected), see the conflict pass below.
      if (seen[pi + ':' + kd.kind]) { conflict[pi] = true; res.mismatches.push({ edit: i, paragraphIndex: pi, kind: kd.kind, reason: 'duplicate ' + kd.kind + ' for this paragraphIndex in edits' }); continue; }
      if (seen[pi + ':' + (kd.kind === 'delete' ? 'replace' : 'delete')]) { conflict[pi] = true; res.mismatches.push({ edit: i, paragraphIndex: pi, kind: kd.kind, reason: 'a paragraph cannot be both replaced and deleted in one call' }); continue; }
      seen[pi + ':' + kd.kind] = true;
    }
    list.push({ e: e, i: i, pi: pi, kind: kd.kind, phase: kd.phase });
  }
  // Last paragraph first; at one index: inserts (reverse given order, so they end
  // up in given order), then the replace, then the delete.
  list.sort(function (a, b) { if (a.pi !== b.pi) return b.pi - a.pi; if (a.phase !== b.phase) return a.phase - b.phase; return b.i - a.i; });
  // Validation pass on the untouched story; one bad edit blocks its whole paragraph.
  var bad = {}, k, it;
  for (k = 0; k < list.length; k++) {
    it = list[k];
    if (conflict[it.pi]) { it.err = 'skipped: conflicting edits for this paragraphIndex (replace and delete, or duplicate)'; bad[it.pi] = true; continue; }
    var pv = __sc_plan(doc, story, it, keepLeading, opts);
    if (pv.err) { it.err = pv.err; it.extra = pv.extra; bad[it.pi] = true; }
    else {
      it.lineCountBefore = pv.lineCountBefore;
      // Composition before the write (an insert inherits its anchor paragraph's state).
      if (!opts.dryRun) { try { it.composedBefore = __sc_paraComposed(story.paragraphs[it.pi]); } catch (eCb) { it.composedBefore = null; } }
    }
  }
  // List-numbering snapshot (up to 30 numbered paragraphs from the lowest edited index).
  var numSnap = null, minPi = null;
  for (k = 0; k < list.length; k++) if (!bad[list[k].pi] && (minPi === null || list[k].pi < minPi)) minPi = list[k].pi;
  if (!opts.dryRun && minPi !== null) { try { numSnap = __sc_numberingSnap(story, minPi, 30, 400); } catch (eNs) { numSnap = null; } }
  var done = [], insertSeen = {};
  for (k = 0; k < list.length; k++) {
    it = list[k];
    var mm = function (reason, extra) { var o = { edit: it.i, paragraphIndex: it.pi, kind: it.kind, reason: reason }; if (extra) for (var x in extra) o[x] = extra[x]; res.mismatches.push(o); };
    if (it.err) { mm(it.err, it.extra); continue; }
    if (bad[it.pi]) { mm('skipped: another edit for this paragraph did not validate, so none of its edits were applied'); continue; }
    var pl = __sc_plan(doc, story, it, keepLeading, opts);
    if (pl.err) { mm(pl.err, pl.extra); continue; }
    var info = pl.info;
    var entry = { edit: it.i, kind: it.kind, paragraphIndex: it.pi, styleId: info.styleId, style: info.styleName, before: __tp_trunc(info.txt, 200) };
    if (pl.mode) entry.mode = pl.mode;
    if (pl.target) { entry.targetStyleId = pl.target.id; entry.targetStyle = __tp_stylePath(pl.target); }
    if (it.kind === 'replace') { entry.leadingPrefix = info.pre; entry.lineCountBefore = it.lineCountBefore; }
    if (pl.lv) {
      entry.labelFontStyle = pl.lv.labelFontStyle; entry.valueFontStyle = pl.lv.valueFontStyle;
      entry.labelFontStyleRaw = pl.lv.labelFontStyleRaw; entry.valueFontStyleRaw = pl.lv.valueFontStyleRaw; entry.fontStyleSource = pl.lv.runsSource;
    }
    if (pl.tables) entry.tables = pl.tables;
    if (pl.grepWarning) { entry.grepWarning = pl.grepWarning; res.warnings.push('edit ' + it.i + ' (paragraph ' + it.pi + '): ' + pl.grepWarning); }
    // The insert processed first at an index is the LAST one of its block (inserts run in reverse order).
    if (it.kind === 'insert' && !insertSeen[it.pi]) { it.checkNext = true; insertSeen[it.pi] = true; }
    if (opts.dryRun) {
      entry.dryRun = true;
      if (it.checkNext || (it.kind === 'replace' && pl.restyle)) {
        var dry = __sc_checkNextSpacing(story, it.pi + 1, false, {});
        if (dry) {
          entry.nextParagraph = dry;
          var dw = __sc_spacingWarning(it.pi + 1, dry, it.i, ' (index before this call)');
          for (var dwi = 0; dwi < dw.length; dwi++) res.warnings.push(dw[dwi] + (it.e.resetNextSpacing === true && dry.beforeOverridden ? ' [resetNextSpacing would set it to the style value]' : ''));
        }
      }
      res.applied.push(entry);
      continue;
    }
    if (it.kind === 'delete') it.delta = __sc_doDelete(story, it, pl, res, entry);
    else if (it.kind === 'insert') it.delta = __sc_doInsert(story, it, pl, res, entry);
    else it.delta = __sc_doReplace(story, it, pl, res, entry);
    it.entry = entry;
    done.push(it);
    res.applied.push(entry);
  }
  res.applied.reverse();
  try { story.recompose(); } catch (e3) {}
  if (!opts.dryRun && done.length) {
    // Final paragraph index of every replaced / inserted paragraph.
    var asc = done.slice(0).reverse(), running = 0, ix = 0;
    while (ix < asc.length) {
      var gpi = asc[ix].pi, grp = [];
      while (ix < asc.length && asc[ix].pi === gpi) grp.push(asc[ix++]);
      var base = gpi + running, deleted = false, rep = null, ins = [], g;
      for (g = 0; g < grp.length; g++) { if (grp[g].kind === 'delete') deleted = true; else if (grp[g].kind === 'replace') rep = grp[g]; else ins.push(grp[g]); }
      if (rep) rep.finalIndex = base;
      var off = deleted ? 0 : 1 + (rep ? rep.delta : 0);
      for (g = 0; g < ins.length; g++) { ins[g].finalIndex = base + off; off += ins[g].delta; }
      for (g = 0; g < grp.length; g++) running += grp[g].delta;
    }
    for (k = 0; k < done.length; k++) {
      var d = done[k];
      if (d.finalIndex === undefined) continue;
      d.entry.finalParagraphIndex = d.finalIndex;
      var fq = null; try { fq = story.paragraphs[d.finalIndex]; if (!fq.isValid) fq = null; } catch (eq) { fq = null; }
      if (!fq) continue;
      var lc = null; try { lc = fq.lines.length; } catch (el) {}
      d.entry.lineCountAfter = lc;
      var composed = __sc_paraComposed(fq);
      if (composed === null) composed = true;
      if (!composed) {
        res.warnings.push('paragraph ' + d.finalIndex + ' (edit ' + d.i + ', ' + d.kind + ') is not composed: it is overset text');
        // design-r3-03: composed before, overset now -> caused by this write.
        if (d.composedBefore === true) {
          var ptf0 = null; try { ptf0 = story.paragraphs[d.finalIndex].insertionPoints[0].parentTextFrames; } catch (ePf) {}
          var fid0 = null; try { fid0 = ptf0 && ptf0.length ? ptf0[0].id : null; } catch (ePf2) {}
          if (fid0 === null) { try { var tcs = story.textContainers; fid0 = tcs.length ? tcs[tcs.length - 1].id : null; } catch (ePf3) {} }
          res.newOverset.push({ edit: d.i, paragraphIndex: d.pi, finalParagraphIndex: d.finalIndex, kind: d.kind, frameId: fid0, text: __tp_trunc(fq.contents, 80) });
        }
      }
      var ft = ''; try { ft = __tp_str(fq.contents); } catch (et) {}
      if (ft.substring(0, 2) === '￼\t' && d.lineCountBefore === 1 && lc !== null && lc > 1) {
        res.warnings.push('paragraph ' + d.finalIndex + ' (edit ' + d.i + '): icon line wraps onto ' + lc + ' lines; style has no hanging indent');
      }
    }
    // Spacing of the paragraph after an inserted / restyled block (final index).
    for (k = 0; k < done.length; k++) {
      var ds = done[k];
      if (!ds.nextSpacing || ds.finalIndex === undefined) continue;
      var nIdx = ds.kind === 'insert' ? ds.finalIndex + ds.delta : ds.finalIndex + ds.delta + 1;
      var sw = __sc_spacingWarning(nIdx, ds.nextSpacing, ds.i, '');
      for (var swi = 0; swi < sw.length; swi++) res.warnings.push(sw[swi]);
      if (ds.entry.spacingReset) ds.entry.spacingReset.paragraphIndex = nIdx;
    }
    // List numbering: compare the numbers of untouched numbered paragraphs after
    // the edits with what the inserted/deleted numbered paragraphs explain.
    if (numSnap && numSnap.length) {
      var editedAt = {}, changes = [];
      for (k = 0; k < done.length; k++) editedAt[done[k].pi] = true;
      for (var ns = 0; ns < numSnap.length; ns++) {
        var sn = numSnap[ns];
        if (editedAt[sn.pi]) continue;
        // Start of sn's list segment: the last restart (same list) at or before it.
        var segStart = minPi;
        for (var rs = 0; rs <= ns; rs++) if (numSnap[rs].restart && numSnap[rs].listKey === sn.listKey) segStart = numSnap[rs].pi;
        var shift = 0, numShift = 0;
        for (k = 0; k < done.length; k++) {
          var dn = done[k];
          if (dn.pi >= sn.pi) continue;
          shift += dn.delta;
          if (dn.pi >= segStart && dn.listKey === sn.listKey && (sn.restart ? false : true)) numShift += (dn.numDelta || 0);
        }
        var nq = sn.pi + shift, after = null, nowNumbered = false;
        try { var pq = story.paragraphs[nq]; nowNumbered = __sc_isNumbered(pq); after = __tp_str(pq.bulletsAndNumberingResultText); } catch (eNq) {}
        var bN = __sc_numVal(sn.text), aN = __sc_numVal(after), bad2 = false, expected = null;
        if (!nowNumbered) bad2 = true;
        else if (bN !== null && aN !== null) { expected = bN + numShift; bad2 = aN !== expected; }
        else if (numShift === 0) bad2 = after !== sn.text;
        if (bad2) changes.push({ paragraphIndex: nq, paragraphIndexBefore: sn.pi, text: sn.excerpt, before: sn.text, after: nowNumbered ? after : '(no longer numbered)', expected: expected });
      }
      if (changes.length) {
        res.numberingChanges = changes;
        var parts = [];
        for (var cg = 0; cg < changes.length && cg < 10; cg++) parts.push(changes[cg].paragraphIndex + ' (' + __tp_trunc(changes[cg].before, 12) + ' -> ' + __tp_trunc(changes[cg].after, 12) + (changes[cg].expected !== null ? ', expected ' + changes[cg].expected : '') + ')');
        res.warnings.push('list numbering changed for paragraphs ' + parts.join(', ') + (changes.length > 10 ? ' and ' + (changes.length - 10) + ' more' : '') + ' beyond what the inserted/deleted numbered paragraphs explain; see numberingChanges');
      }
    }
  }
  res.storyOverflows = story.overflows;
  var newlyOverflows = !opts.dryRun && res.storyOverflows && res.storyOverflowsBefore === false;
  if (newlyOverflows) res.warnings.push('story ' + story.id + ' now overflows (overset text) and did not before this call; thread it with continue_story or shorten the text');
  res.storyLength = story.characters.length;
  res.anchorsAfter = __tp_anchorCount(story);
  res.rollbackRequired = !opts.dryRun && (res.anchorsAfter !== res.anchorsBefore || res.styleErrors.length > 0);
  // design-r3-03: text hidden by this write (story newly overflows, or an edited
  // paragraph that was composed is now overset). With opts.rollbackOnOverset the
  // caller undoes the write and reports a mismatch (allowOverset:true keeps it).
  if (!opts.dryRun && done.length && (newlyOverflows || res.newOverset.length)) {
    var tcs2 = null, frames = []; try { tcs2 = story.textContainers; for (var tci = 0; tci < tcs2.length; tci++) frames.push(tcs2[tci].id); } catch (eTc) {}
    var lastFrame = frames.length ? frames[frames.length - 1] : null;
    res.oversetCaused = { storyId: story.id, storyOverflowsBefore: res.storyOverflowsBefore, storyOverflowsAfter: res.storyOverflows, frames: frames, singleUnthreadedFrame: frames.length === 1, paragraphs: res.newOverset };
    if (opts.rollbackOnOverset) {
      res.oversetRollback = true;
      var oParts = [];
      for (var op = 0; op < res.newOverset.length; op++) oParts.push('paragraph ' + res.newOverset[op].paragraphIndex + ' (edit ' + res.newOverset[op].edit + ')');
      res.mismatches.push({
        reason: 'pushed into overset: the write leaves text hidden' + (frames.length === 1 ? ' in the single unthreaded frame ' + lastFrame : ' after the last frame ' + lastFrame + ' of the story') +
          (oParts.length ? ' (' + oParts.join(', ') + ' was composed before and is overset now)' : ' (story ' + story.id + ' did not overflow before this call and does now)') + '; the write was undone',
        kind: 'overset', storyId: story.id, frameId: lastFrame, singleUnthreadedFrame: frames.length === 1, paragraphs: res.newOverset,
        suggestion: 'shorten the text, fit/enlarge the frame or thread it with continue_story (your decision), or call again with allowOverset:true to keep the overset text'
      });
    } else if (opts.allowOverset) res.warnings.push('overset text kept because allowOverset:true');
  }
  return res;
}
// Composition of a paragraph: true when its last character (or, if empty, its
// insertion point) sits in a text frame; null when it could not be measured.
function __sc_paraComposed(p) {
  try {
    if (!p || !p.isValid) return null;
    if (p.characters.length) return p.characters[-1].parentTextFrames.length > 0;
    return p.insertionPoints[0].parentTextFrames.length > 0;
  } catch (e) { return null; }
}
// Write a whole content string into a frame's story, 1:1 paragraph mapping,
// through __tp_replaceParagraphs (so anchors/tabs/\r/styles survive).
function __tp_fillFrameStory(doc, tf, content, dryRun) {
  var story = tf.parentStory;
  var paras = String(content).split('\r');
  if (paras.length > 1 && paras[paras.length - 1] === '') paras.pop();
  var first = 0;
  try {
    var fs0 = tf.texts[0].insertionPoints[0].index;
    var sc = __tp_str(story.contents);
    for (var i = 0; i < fs0 && i < sc.length; i++) if (sc.charAt(i) === '\r') first++;
  } catch (e) {}
  var n = story.paragraphs.length - first;
  if (paras.length !== n) {
    return { filled: false, mismatch: { reason: 'content has ' + paras.length + ' paragraph(s) but the template frame story has ' + n + ' from this frame on; send per-paragraph edits (replace_paragraphs) instead of guessing', contentParagraphs: paras.length, templateParagraphs: n } };
  }
  var edits = [];
  for (var j = 0; j < paras.length; j++) edits.push({ paragraphIndex: first + j, text: paras[j] });
  var r = __tp_replaceParagraphs(doc, story, edits, { keepLeadingAnchors: true, dryRun: !!dryRun });
  return { filled: r.mismatches.length === 0, result: r };
}
`;

const CONTACT_JSX = jsx`
function __tp_detectContactType(text, hint) {
  var h = String(hint || '').toLowerCase();
  if (/phone|tel|call|mobile|hotline/.test(h)) return 'phone';
  if (/mail|envelope/.test(h)) return 'email';
  if (/web|globe|www|link|url|internet/.test(h)) return 'web';
  if (/address|location|pin|map|home|marker/.test(h)) return 'address';
  var t = String(text).replace(/^[\s￼\t]+/, '').replace(/\s+$/, '');
  if (/^fax/i.test(t)) return 'fax';
  if (/@/.test(t)) return 'email';
  if (/(https?:\/\/|www\.)/i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) return 'web';
  var digits = t.replace(/\D/g, '').length, letters = t.replace(/[^A-Za-z]/g, '').length;
  if (digits >= 6 && digits >= letters) return 'phone';
  return 'address';
}
function __tp_segments(story) {
  var txt = __tp_str(story.contents);
  if (txt.length !== story.characters.length) throw new Error('story contains special characters whose text length differs from the character count; cannot map contact lines safely');
  var segs = [], s = 0;
  for (var i = 0; i <= txt.length; i++) {
    var ch = i < txt.length ? txt.charAt(i) : '\r';
    if (ch === '\r' || ch === '\n') {
      if (i > s) {
        var t = txt.substring(s, i), pre = 0;
        while (pre < t.length && (t.charAt(pre) === '￼' || t.charAt(pre) === '\t')) pre++;
        segs.push({ a: s, b: i, text: t, pre: pre, anchors: __tp_count(t, '￼') });
      }
      s = i + 1;
    }
  }
  return segs;
}
function __tp_baselineAt(story, idx) {
  try { return __tp_round(story.characters[idx].baseline); } catch (e) {}
  try { return __tp_round(story.insertionPoints[idx].baseline); } catch (e2) {}
  return null;
}
function __tp_inlineIcon(story, seg) {
  try {
    var items = story.characters[seg.a].allPageItems;
    if (items.length) { var it = items[0]; return { id: it.id, name: it.name || '', bounds: it.geometricBounds }; }
  } catch (e) {}
  return null;
}
function __sc_trunc(s, n) { s = __tp_str(s); return s.length > n ? s.substring(0, n) + '...' : s; }
// Split a story's inline-icon lines into blocks: maximal runs of consecutive icon
// lines. A non-icon paragraph or an empty line ends a block. A non-icon segment
// that continues an icon line after a forced line break (\n) belongs to that line.
function __sc_inlineBlocks(story) {
  var txt = __tp_str(story.contents);
  var all = __tp_segments(story);
  var blocks = [], cur = null, prevB = -2, para = 0, scan = 0;
  for (var j = 0; j < all.length; j++) {
    var sg = all[j];
    for (; scan < sg.a; scan++) if (txt.charAt(scan) === '\r') para++;
    sg.paragraphIndex = para;
    var isIcon = sg.text.charAt(0) === '￼' || (sg.pre > 0 && sg.anchors > 0);
    var adjacent = sg.a === prevB + 1;
    if (isIcon) {
      if (cur && adjacent) cur.segs.push(sg);
      else { cur = { blockIndex: blocks.length, segs: [sg] }; blocks.push(cur); }
    } else if (cur && adjacent && txt.charAt(sg.a - 1) === '\n') {
      var last = cur.segs[cur.segs.length - 1];
      last.b = sg.b;
      last.text = txt.substring(last.a, last.b);
      last.anchors = __tp_count(last.text, '￼');
      last.continued = true;
    } else cur = null;
    prevB = sg.b;
  }
  for (var b = 0; b < blocks.length; b++) {
    var bs = blocks[b].segs;
    blocks[b].firstParagraphIndex = bs[0].paragraphIndex;
    blocks[b].lastParagraphIndex = bs[bs.length - 1].paragraphIndex;
  }
  return blocks;
}
function __sc_blockSummary(blocks, max) {
  var out = [];
  for (var i = 0; i < blocks.length && i < max; i++) {
    var bl = blocks[i], types = [];
    for (var j = 0; j < bl.segs.length; j++) types.push(__tp_detectContactType(bl.segs[j].text, ''));
    out.push({ blockIndex: bl.blockIndex, firstParagraphIndex: bl.firstParagraphIndex, lineCount: bl.segs.length, types: types, firstLineText: __sc_trunc(bl.segs[0].text.substring(bl.segs[0].pre), 80) });
  }
  return out;
}
// scope: {blockIndex, paragraphIndex}. Order: blockIndex, then paragraph
// containment, then exactly one block starting inside the frame's text.
function __sc_selectBlock(blocks, frame, scope) {
  var MAX = 200;
  function fail(reason, list) {
    var m = { reason: reason, blockCount: blocks.length, availableBlocks: __sc_blockSummary(list, MAX) };
    if (list.length > MAX) m.availableBlocksTruncated = true;
    m.hint = 'pass blockIndex or firstParagraphIndex (storyParagraphIndex) of the block to replace';
    return { mismatch: m };
  }
  if (blocks.length === 0) return fail('the story has no lines that start with an inline anchored icon', blocks);
  if (scope.blockIndex !== null && scope.blockIndex !== undefined) {
    var bi = Number(scope.blockIndex);
    if (bi < 0 || bi >= blocks.length) return fail('blockIndex ' + bi + ' out of range (story has ' + blocks.length + ' contact blocks)', blocks);
    return { block: blocks[bi], by: 'blockIndex' };
  }
  if (scope.paragraphIndex !== null && scope.paragraphIndex !== undefined) {
    var pi = Number(scope.paragraphIndex);
    for (var i = 0; i < blocks.length; i++) if (pi >= blocks[i].firstParagraphIndex && pi <= blocks[i].lastParagraphIndex) return { block: blocks[i], by: 'paragraphIndex' };
    return fail('no contact block contains story paragraph ' + pi, blocks);
  }
  var fs = -1, fe = -1;
  try { var tx = frame.texts[0]; fs = tx.insertionPoints[0].index; fe = tx.insertionPoints[-1].index; } catch (e) {}
  var hits = [];
  for (var h = 0; h < blocks.length; h++) { var a0 = blocks[h].segs[0].a; if (a0 >= fs && a0 < fe) hits.push(blocks[h]); }
  if (hits.length === 1) return { block: hits[0], by: 'frameTextRange' };
  if (hits.length === 0) return fail('no contact block starts inside frame ' + frame.id + ' (its text is story characters ' + fs + '-' + fe + ')', blocks);
  return fail(hits.length + ' contact blocks start inside frame ' + frame.id + '; choose one', hits);
}
function __tp_contactStructure(doc, groupId, frameId, scope) {
  scope = scope || {};
  var st = { kind: null, story: null, icons: [], segs: [], continued: [] };
  var group = null, frame = null;
  if (groupId !== null) {
    group = __tp_requireItem(doc, groupId, 'group');
    if (__tp_type(group) !== 'Group') throw new Error('item ' + groupId + ' is a ' + __tp_type(group) + ', not a Group');
  } else {
    frame = __tp_requireTextFrame(doc, frameId);
    var fstory = frame.parentStory;
    if (__tp_anchorCount(fstory) === 0 && __tp_type(frame.parent) === 'Group') group = frame.parent;
  }
  if (group) {
    var kids = group.pageItems, frames = [];
    for (var i = 0; i < kids.length; i++) {
      var kid = __tp_concrete(kids[i]);
      if (__tp_type(kid) === 'TextFrame') frames.push(kid);
      else st.icons.push({ id: kid.id, name: kid.name || '', bounds: kid.geometricBounds, type: __tp_type(kid) });
    }
    if (frame === null) {
      if (frames.length !== 1) throw new Error('group ' + group.id + ' has ' + frames.length + ' text frames; expected exactly 1 (pass frameId)');
      frame = frames[0];
    }
    st.kind = 'group';
    st.groupId = group.id;
    st.icons.sort(function (a, b) { return a.bounds[0] - b.bounds[0]; });
    st.story = frame.parentStory;
    st.segs = __tp_segments(st.story);
  } else {
    st.kind = 'inlineAnchors';
    st.story = frame.parentStory;
    var blocks = __sc_inlineBlocks(st.story);
    st.blockCount = blocks.length;
    var sel = __sc_selectBlock(blocks, frame, scope);
    st.frameId = frame.id;
    if (sel.mismatch) { st.blockMismatch = sel.mismatch; return st; }
    var blk = sel.block;
    st.blockIndex = blk.blockIndex;
    st.firstParagraphIndex = blk.firstParagraphIndex;
    st.selectedBy = sel.by;
    for (var j = 0; j < blk.segs.length; j++) {
      var sg = blk.segs[j];
      if (sg.anchors > 1) {
        st.blockMismatch = { reason: 'contact line ' + j + ' of block ' + blk.blockIndex + ' has ' + sg.anchors + ' anchored objects; expected one icon per line', text: __sc_trunc(sg.text, 120) };
        st.segs = []; st.icons = [];
        return st;
      }
      st.segs.push(sg);
      if (sg.continued) st.continued.push(j);
      var ic = __tp_inlineIcon(st.story, sg);
      st.icons.push(ic || { id: null, name: '', bounds: null });
    }
  }
  st.frameId = frame.id;
  return st;
}
function __tp_contactPositions(st) {
  var out = [];
  for (var i = 0; i < st.segs.length; i++) {
    var ic = st.icons[i];
    var bl = __tp_baselineAt(st.story, st.segs[i].a + st.segs[i].pre);
    var cy = ic && ic.bounds ? __tp_round((ic.bounds[0] + ic.bounds[2]) / 2) : null;
    var li = __sc_lineInfo(st.story, st.segs[i]);
    // Wrap check from the composed line count; the baseline comparison is only a fallback.
    var wr = li.lineCount !== null ? li.lineCount > li.expectedLines : __sc_wraps(st.story, st.segs[i]);
    out.push({ iconCenterY: cy, baseline: bl, delta: (cy !== null && bl !== null) ? __tp_round(cy - bl) : null, wraps: wr,
               lineCount: li.lineCount, expectedLines: li.expectedLines, composed: li.composed, partlyOverset: li.partlyOverset, frameId: li.frameId, frameWidth: li.frameWidth });
  }
  return out;
}
// Composition of one contact line: composed (its first text character sits in
// a frame), lineCount (composed lines of the range), expectedLines (1 + forced
// line breaks inside the line), frameId and the frame's text width.
function __sc_lineInfo(story, seg) {
  var s = seg.a + seg.pre, e = seg.b - 1;
  if (e < s) { s = seg.a; e = Math.max(seg.a, seg.b - 1); }
  var o = { composed: false, lineCount: null, expectedLines: 1, frameId: null, frameWidth: null, partlyOverset: false };
  try { o.expectedLines = 1 + __tp_count(__tp_str(story.characters.itemByRange(s, e).contents), '\n'); } catch (eX) {}
  try {
    var ptf = story.characters[s].parentTextFrames;
    o.composed = ptf.length > 0;
    if (ptf.length) { o.frameId = ptf[0].id; o.frameWidth = __sc_textWidth(ptf[0]); }
  } catch (e1) {}
  if (o.composed) {
    var rg = story.characters.itemByRange(s, e);
    try { o.lineCount = rg.lines.length; } catch (e2) { try { o.lineCount = rg.texts[0].lines.length; } catch (e3) { o.lineCount = null; } }
    try { o.partlyOverset = story.characters[e].parentTextFrames.length === 0; } catch (e4) {}
  }
  return o;
}
function __sc_textWidth(tf) {
  try {
    var b = tf.geometricBounds, w = b[3] - b[1];
    var ins = tf.textFramePreferences.insetSpacing;
    if (ins instanceof Array) w -= (Number(ins[1]) + Number(ins[3]));
    else if (typeof ins === 'number') w -= 2 * ins;
    return __tp_round(w);
  } catch (e) { return null; }
}
// Resolve extraIcons[].iconFrom to the anchored icon to duplicate.
//   {storyId, characterIndex}: the U+FFFC character holding an inline icon
//   {pageItemId}: an anchored item (its anchor character is used) or a free page item
function __sc_iconSource(doc, f) {
  f = f || {};
  if (f.pageItemId !== null && f.pageItemId !== undefined) {
    var item = __tp_itemById(doc, f.pageItemId);
    if (!item) return { error: 'iconFrom.pageItemId ' + f.pageItemId + ' not found' };
    var par = null; try { par = item.parent; } catch (e0) {}
    var gb = null; try { gb = item.geometricBounds; } catch (e1) {}
    if (__tp_type(par) === 'Character') return { kind: 'character', ch: par, item: item, bounds: gb };
    return { kind: 'pageItem', item: item, bounds: gb };
  }
  if (f.storyId !== null && f.storyId !== undefined) {
    var s = doc.stories.itemByID(Number(f.storyId));
    if (!__tp_valid(s)) return { error: 'iconFrom.storyId ' + f.storyId + ' not found' };
    var ci = Number(f.characterIndex);
    if (isNaN(ci) || ci < 0 || ci >= s.characters.length) return { error: 'iconFrom.characterIndex ' + f.characterIndex + ' out of range for story ' + f.storyId };
    var ch = s.characters[ci], items = null;
    try { items = ch.allPageItems; } catch (e2) { items = null; }
    if (!items || !items.length) return { error: 'character ' + ci + ' of story ' + f.storyId + ' is not an anchored object' };
    return { kind: 'character', ch: ch, item: items[0], bounds: items[0].geometricBounds };
  }
  return { error: 'iconFrom needs {storyId, characterIndex} or {pageItemId}' };
}
function __sc_size(b) { return b ? { width: __tp_round(b[3] - b[1]), height: __tp_round(b[2] - b[0]) } : null; }
// true when the line's first and last text characters sit on different baselines.
function __sc_wraps(story, seg) {
  var s = seg.a + seg.pre, e = seg.b - 1;
  if (e <= s) return false;
  var b1 = __tp_baselineAt(story, s), b2 = __tp_baselineAt(story, e);
  return b1 !== null && b2 !== null && Math.abs(b1 - b2) > 0.5;
}
`;

const CONTINUE_JSX = jsx`
function __sc_t(s, n) { s = __tp_str(s); return s.length > n ? s.substring(0, n) + '...' : s; }
function __sc_startName(v) {
  var names = ['ANYWHERE', 'NEXT_COLUMN', 'NEXT_FRAME', 'NEXT_PAGE', 'NEXT_ODD_PAGE', 'NEXT_EVEN_PAGE'];
  for (var i = 0; i < names.length; i++) { try { if (v === StartParagraph[names[i]]) return names[i]; } catch (e) {} }
  try { return String(v); } catch (e2) { return null; }
}
function __sc_breakName(c) {
  var names = ['PAGE_BREAK', 'FRAME_BREAK', 'COLUMN_BREAK', 'ODD_PAGE_BREAK', 'EVEN_PAGE_BREAK'];
  var v; try { v = c.contents; } catch (e) { return null; }
  for (var i = 0; i < names.length; i++) { try { if (v === SpecialCharacters[names[i]]) return names[i]; } catch (e2) {} }
  return null;
}
function __sc_contentHeight(tf) {
  var b = tf.geometricBounds, h = b[2] - b[0];
  try {
    var ins = tf.textFramePreferences.insetSpacing;
    if (ins instanceof Array) h -= (Number(ins[0]) + Number(ins[2]));
    else if (typeof ins === 'number') h -= 2 * ins;
  } catch (e) {}
  return __tp_round(h);
}
// Diagnose why overset text did not flow into the empty frame nf (on page np).
// Returns { report: <JSON-safe>, table: <Table or null> }.
function __sc_flowBlocker(story, nf, np) {
  var rep = { reasons: [] }, tableObj = null;
  var conts = story.textContainers, lastIdx = -1;
  for (var i = conts.length - 1; i >= 0; i--) {
    if (conts[i].id === nf.id) continue;
    try { var cs = conts[i].characters; if (cs.length) { lastIdx = cs[-1].index; break; } } catch (e) {}
  }
  var idx = lastIdx + 1, total = story.characters.length;
  var fh = __sc_contentHeight(nf);
  rep.firstOversetCharIndex = idx;
  rep.frameContentHeight = fh;
  rep.newPageSide = __tp_side(np);
  if (idx >= total) { rep.reasons.push('no overset character found after the last composed character (index ' + lastIdx + ')'); return { report: rep, table: null }; }
  var txt = __tp_str(story.contents);
  rep.indexApproximate = txt.length !== total;
  var pc = 0; for (var k = 0; k < idx && k < txt.length; k++) if (txt.charAt(k) === '\r') pc++;
  rep.paragraphIndex = pc;
  var ch = story.characters[idx];
  var para = ch.paragraphs[0];
  var pStart = para.insertionPoints[0].index, pEnd = para.insertionPoints[-1].index;
  rep.paragraphText = __sc_t(para.contents, 160);
  rep.charOffsetInParagraph = idx - pStart;
  try { rep.paragraphStyle = __tp_stylePath(para.appliedParagraphStyle); } catch (e1) {}
  var ko = {};
  var kp = ['keepAllLinesTogether', 'keepLinesTogether', 'keepWithNext', 'keepFirstLines', 'keepLastLines', 'keepWithPrevious'];
  for (var q = 0; q < kp.length; q++) { try { var kv = para[kp[q]]; ko[kp[q]] = (typeof kv === 'boolean' || typeof kv === 'number') ? kv : String(kv); } catch (e2) {} }
  try { ko.startParagraph = __sc_startName(para.startParagraph); } catch (e3) {}
  rep.keepOptions = ko;
  if (ko.startParagraph === 'NEXT_ODD_PAGE' && rep.newPageSide === 'left') rep.reasons.push('paragraph ' + pc + ' must start on an odd page (startParagraph NEXT_ODD_PAGE) but the new page is a left-hand page');
  if (ko.startParagraph === 'NEXT_EVEN_PAGE' && rep.newPageSide === 'right') rep.reasons.push('paragraph ' + pc + ' must start on an even page (startParagraph NEXT_EVEN_PAGE) but the new page is a right-hand page');
  var brk = [];
  for (var bi = idx - 1; bi <= idx; bi++) { if (bi < 0 || bi >= total) continue; var bn = __sc_breakName(story.characters[bi]); if (bn) brk.push({ index: bi, character: bn }); }
  if (brk.length) { rep.breakCharacters = brk; rep.reasons.push('break character ' + brk[0].character + ' at story index ' + brk[0].index); }
  // Anchored object at the overset position.
  try {
    var items = ch.allPageItems;
    if (items.length) {
      var ai = items[0], gb = ai.geometricBounds, ah = __tp_round(gb[2] - gb[0]);
      rep.anchoredObject = { id: ai.id, type: __tp_type(ai), height: ah, frameContentHeight: fh, fits: ah <= fh };
      if (ah > fh) rep.reasons.push('anchored ' + __tp_type(ai) + ' ' + ai.id + ' is ' + ah + 'pt tall but the frame holds ' + fh + 'pt');
    }
  } catch (e4) {}
  // Table at / around the overset position.
  try {
    var tables = story.tables;
    for (var t = 0; t < tables.length; t++) {
      var off = -1; try { off = tables[t].storyOffset.index; } catch (e5) {}
      if (off === idx || off === idx - 1 || (off >= pStart && off < pEnd)) { tableObj = tables[t]; rep.tableStoryOffset = off; break; }
    }
  } catch (e6) {}
  if (tableObj) {
    var tr = { tableId: tableObj.id, storyOffset: rep.tableStoryOffset, frameContentHeight: fh };
    try { tr.rowCount = tableObj.rows.length; } catch (e7) {}
    try { tr.headerRowCount = tableObj.headerRowCount; tr.footerRowCount = tableObj.footerRowCount; } catch (e8) {}
    var hs = [], kw = [], sr = [];
    try { hs = __tp_arr(tableObj.rows.everyItem().height); } catch (e9) {}
    try { kw = __tp_arr(tableObj.rows.everyItem().keepWithNextRow); } catch (e10) {}
    try { sr = __tp_arr(tableObj.rows.everyItem().startRow); } catch (e11) {}
    var headH = 0, maxH = 0, tall = [], keepRows = [], startRows = [];
    for (var r = 0; r < hs.length; r++) {
      var rh = Number(hs[r]);
      if (r < (tr.headerRowCount || 0)) headH += rh;
      if (rh > maxH) maxH = rh;
      if (rh > fh && tall.length < 20) tall.push({ rowIndex: r, height: __tp_round(rh) });
      if (kw[r] === true && keepRows.length < 50) keepRows.push(r);
      var sn = sr.length > r ? __sc_startName(sr[r]) : 'ANYWHERE';
      if (sn !== 'ANYWHERE' && startRows.length < 50) startRows.push({ rowIndex: r, startRow: sn });
    }
    tr.headerRowsHeight = __tp_round(headH);
    tr.maxRowHeight = __tp_round(maxH);
    tr.rowsTallerThanFrame = tall;
    tr.keepWithNextRows = keepRows;
    tr.startRowNotAnywhere = startRows;
    var cellList = [];
    try {
      var ov = __tp_arr(tableObj.cells.everyItem().overflows), oc = 0;
      for (var c = 0; c < ov.length; c++) {
        if (ov[c] !== true) continue;
        oc++;
        if (cellList.length >= 20) continue;
        var cl = { tableId: tableObj.id, cellIndex: c, row: null, column: null, rowHeight: null, cellHeight: null, textExcerpt: null, cellOverflows: true };
        try {
          var cell = tableObj.cells[c];
          try { cl.row = cell.parentRow.index; cl.rowHeight = __tp_round(cell.parentRow.height); } catch (eRw) {}
          try { cl.column = cell.parentColumn.index; } catch (eCo) {}
          try { cl.cellHeight = __tp_round(cell.height); } catch (eCh) {}
          try { cl.textExcerpt = __sc_t(cell.contents, 60); } catch (eTx) {}
        } catch (eCell) {}
        cellList.push(cl);
      }
      tr.oversetCells = oc;
    } catch (e12) {}
    tr.oversetCellList = cellList;
    rep.oversetCells = cellList;
    // Paragraphs after the table that are overset as well (often empty returns).
    var trailing = [];
    try {
      var tOff = rep.tableStoryOffset, tPara = 0;
      for (var tk = 0; tk < tOff && tk < txt.length; tk++) if (txt.charAt(tk) === '\r') tPara++;
      var nPar = story.paragraphs.length;
      for (var tq = tPara + 1; tq < nPar && trailing.length < 20; tq++) {
        var tp = story.paragraphs[tq], comp = true;
        try { comp = tp.characters.length ? tp.characters[0].parentTextFrames.length > 0 : tp.insertionPoints[0].parentTextFrames.length > 0; } catch (eC2) {}
        if (comp) continue;
        var ptx = __tp_str(tp.contents).replace(/\r$/, '');
        var pst = ''; try { pst = __tp_stylePath(tp.appliedParagraphStyle); } catch (eS2) {}
        trailing.push({ index: tq, style: pst, text: ptx.length ? __sc_t(ptx, 60) : '(empty)' });
      }
    } catch (eTr) {}
    rep.trailingParagraphs = trailing;
    tr.rowSplitting = 'InDesign cannot split one table row across frames; a row taller than the frame never flows';
    rep.table = tr;
    if (tall.length) rep.reasons.push('table ' + tableObj.id + ': row ' + tall[0].rowIndex + ' is ' + tall[0].height + 'pt tall but the frame holds ' + fh + 'pt (rows cannot split across frames)');
    else if (headH + maxH > fh) rep.reasons.push('table ' + tableObj.id + ': repeated header rows (' + __tp_round(headH) + 'pt) plus the tallest row (' + __tp_round(maxH) + 'pt) exceed the frame height ' + fh + 'pt');
    if (keepRows.length) rep.reasons.push('table ' + tableObj.id + ': ' + keepRows.length + ' row(s) have keepWithNextRow, forcing rows to move together');
    if (startRows.length) rep.reasons.push('table ' + tableObj.id + ': ' + startRows.length + ' row(s) have a startRow other than ANYWHERE');
    if (!tall.length && !keepRows.length && !startRows.length && headH + maxH <= fh) rep.reasons.push('table ' + tableObj.id + ' did not flow although no row is taller than the frame; check cell contents (overset cells: ' + (tr.oversetCells || 0) +
      (cellList.length ? ', e.g. ' + (function () { var s = []; for (var z = 0; z < cellList.length && z < 3; z++) s.push('row ' + cellList[z].row + ' col ' + cellList[z].column); return s.join(', '); })() : '') +
      '; see blocker.oversetCells)' + (trailing.length ? '; ' + trailing.length + ' paragraph(s) after the table are overset too (blocker.trailingParagraphs)' : ''));
  }
  if (!rep.reasons.length) rep.reasons.push('no blocker identified (check keep options ' + ko.keepAllLinesTogether + '/' + ko.keepWithNext + ' and text wrap on the new page)');
  return { report: rep, table: tableObj };
}
// allowRowBreak: relax the row keep options that can stop a table from flowing.
function __sc_relaxRows(t) {
  var changes = [], raw = [];
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    try { if (r.keepWithNextRow === true) { r.keepWithNextRow = false; changes.push({ rowIndex: i, property: 'keepWithNextRow', from: true, to: false }); raw.push({ i: i, k: 'keepWithNextRow', v: true }); } } catch (e) {}
    try {
      var s0 = r.startRow;
      if (s0 !== StartParagraph.ANYWHERE) { r.startRow = StartParagraph.ANYWHERE; changes.push({ rowIndex: i, property: 'startRow', from: __sc_startName(s0), to: 'ANYWHERE' }); raw.push({ i: i, k: 'startRow', v: s0 }); }
    } catch (e2) {}
  }
  return { changes: changes, raw: raw };
}
function __sc_revertRows(t, raw) {
  for (var i = 0; i < raw.length; i++) { try { t.rows[raw[i].i][raw[i].k] = raw[i].v; } catch (e) {} }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// list_chapter_services — ExtendScript
// ─────────────────────────────────────────────────────────────────────────────

const LIST_SERVICES_JSX = jsx`
function __sc_findServices(story, partHeadingStyleId, partHeadingStyleName) {
  var paras = story.paragraphs;
  var n = paras.length;
  var services = [];
  for (var i = 0; i < n; i++) {
    var p = paras[i];
    var sty = p.appliedParagraphStyle;
    var isPartHeading = false;
    if (partHeadingStyleId !== null && sty.id === partHeadingStyleId) {
      isPartHeading = true;
    } else if (partHeadingStyleName !== null) {
      var nm = __tp_stylePath(sty);
      if (nm === partHeadingStyleName || sty.name === partHeadingStyleName) isPartHeading = true;
    } else {
      var nm2 = sty.name;
      if (nm2 === 'Part Heading' || /Part\\s*Heading/i.test(nm2)) isPartHeading = true;
    }
    if (isPartHeading) {
      if (services.length > 0) services[services.length - 1].endParagraphIndex = i - 1;
      var provName = '';
      if (i + 1 < n) { try { provName = __tp_str(paras[i + 1].contents); } catch (e2) {} }
      services.push({
        serviceIndex: services.length,
        partHeadingText: __tp_str(p.contents),
        providerName: provName,
        startParagraphIndex: i,
        endParagraphIndex: n - 1
      });
    }
  }
  return services;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// TS handlers
// ─────────────────────────────────────────────────────────────────────────────

async function rollbackIfNamed(bridge: InDesignBridge, args: Record<string, unknown>, undoName: string) {
  return runTp(
    bridge,
    args,
    `if (String(doc.undoName) === ${jsStr(undoName)}) { doc.undo(); return __ok({rolledBack: true}); }
     return __ok({rolledBack: false, undoName: String(doc.undoName)});`
  );
}

async function listChapterServices(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    if (args.storyId === undefined && args.frameId === undefined) throw new Error("storyId or frameId is required");
    const body = jsx`
      var story = __tp_requireStory(doc, ${jsNumOpt(args.storyId, "storyId", { int: true })}, ${jsNumOpt(args.frameId, "frameId", { int: true })});
      var phStyleId = ${args.partHeadingStyleId !== undefined && args.partHeadingStyleId !== null ? jsNum(args.partHeadingStyleId, "partHeadingStyleId", { int: true }) : "null"};
      var phStyleName = ${args.partHeadingStyleName !== undefined && args.partHeadingStyleName !== null ? jsStr(String(args.partHeadingStyleName)) : "null"};
      var services = __sc_findServices(story, phStyleId, phStyleName);
      return __ok({ storyId: story.id, totalParagraphs: story.paragraphs.length, serviceCount: services.length, services: services });`;
    return runTp(bridge, args, body, { prelude: REPLACE_PARAGRAPHS_JSX + LIST_SERVICES_JSX });
  });
}

// Resolve service paragraph offset: returns the start index for a given serviceIndex
// within the story, using Part Heading paragraphs as boundaries.
async function resolveServiceOffset(
  bridge: InDesignBridge,
  args: Record<string, unknown>,
  serviceIndex: number
): Promise<{ offset: number; end: number }> {
  const r = await listChapterServices(bridge, args);
  if (!r.success) throw new Error(`list_chapter_services failed: ${r.error}`);
  const data = r.data as Record<string, unknown>;
  const services = data.services as Array<{ serviceIndex: number; startParagraphIndex: number; endParagraphIndex: number }>;
  if (!services || services.length === 0) throw new Error("No Part Heading paragraphs found in this story — cannot use serviceIndex");
  const svc = services.find((s) => s.serviceIndex === serviceIndex);
  if (!svc) throw new Error(`serviceIndex ${serviceIndex} out of range — story has ${services.length} service(s) (0-${services.length - 1})`);
  return { offset: svc.startParagraphIndex, end: svc.endParagraphIndex };
}

function normalizeEdit(e: unknown, i: number) {
  if (!e || typeof e !== "object") throw new Error(`edits[${i}] must be an object`);
  const o = e as Record<string, unknown>;
  const out: Record<string, unknown> = { paragraphIndex: Number(jsNum(o.paragraphIndex, `edits[${i}].paragraphIndex`, { int: true, min: 0 })) };
  for (const k of ["text", "label", "value", "expectText"]) if (o[k] !== undefined && o[k] !== null) out[k] = normalizeText(o[k]);
  if (o.expectStyleId !== undefined && o.expectStyleId !== null) out.expectStyleId = Number(jsNum(o.expectStyleId, `edits[${i}].expectStyleId`, { int: true }));
  if (o.styleId !== undefined && o.styleId !== null) out.styleId = Number(jsNum(o.styleId, `edits[${i}].styleId`, { int: true }));
  if (o.styleName !== undefined && o.styleName !== null && o.styleName !== "") out.styleName = String(o.styleName);
  for (const k of ["expectTableRows", "expectTableColumns"]) {
    if (o[k] !== undefined && o[k] !== null) out[k] = Number(jsNum(o[k], `edits[${i}].${k}`, { int: true, min: 1 }));
  }
  for (const k of ["delete", "insertAfter", "allowTable", "resetNextSpacing", "acceptGrepEffects"]) {
    if (o[k] === undefined || o[k] === null || o[k] === false) continue;
    if (o[k] !== true) throw new Error(`edits[${i}].${k} must be a boolean`);
    out[k] = true;
  }
  return out;
}

async function replaceParagraphs(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error("edits must be a non-empty array");
    if (args.edits.length > 1000) throw new Error("at most 1000 edits per call");
    if (args.storyId === undefined && args.frameId === undefined) throw new Error("storyId or frameId is required");
    let edits = (args.edits as unknown[]).map(normalizeEdit);
    const dryRun = args.dryRun === true;

    // serviceIndex: when provided, paragraph indexes in edits are service-relative.
    // Resolve the absolute offset by finding Part Heading paragraphs in the story.
    let serviceInfo: { offset: number; end: number } | undefined;
    if (args.serviceIndex !== undefined && args.serviceIndex !== null) {
      const si = Number(jsNum(args.serviceIndex, "serviceIndex", { int: true, min: 0 }));
      serviceInfo = await resolveServiceOffset(bridge, args, si);
      const { offset, end } = serviceInfo;
      edits = edits.map((e) => {
        const rel = e.paragraphIndex as number;
        const abs = rel + offset;
        if (abs > end) throw new Error(`edit paragraphIndex ${rel} (absolute ${abs}) exceeds the end of service ${si} (endParagraphIndex ${end})`);
        return { ...e, paragraphIndex: abs };
      });
    }
    if (args.allowOverset !== undefined && args.allowOverset !== null && typeof args.allowOverset !== "boolean") throw new Error("allowOverset must be a boolean");
    const autoFlow = args.autoFlow === true;
    const allowOverset = args.allowOverset === true || autoFlow;
    const body = jsx`
      var story = __tp_requireStory(doc, ${jsNumOpt(args.storyId, "storyId", { int: true })}, ${jsNumOpt(args.frameId, "frameId", { int: true })});
      var res = __tp_replaceParagraphs(doc, story, ${jsJson(edits)}, {keepLeadingAnchors: ${args.keepLeadingAnchors !== false}, dryRun: ${dryRun}, acceptGrepEffects: ${args.acceptGrepEffects === true}, rollbackOnOverset: ${allowOverset !== true}, allowOverset: ${allowOverset === true}});
      return __ok(res);`;
    const r = await runTp(bridge, args, body, {
      prelude: REPLACE_PARAGRAPHS_JSX,
      undoName: dryRun ? undefined : "replace_paragraphs",
      mutating: !dryRun,
    });
    const data = r.data as Record<string, unknown> | undefined;
    if (serviceInfo && data) data.serviceRange = serviceInfo;
    if (r.success && data && data.rollbackRequired) {
      const rb = await rollbackIfNamed(bridge, args, "replace_paragraphs");
      const why: string[] = [];
      if (data.anchorsBefore !== data.anchorsAfter) why.push(`anchored-object count ${data.anchorsBefore} -> ${data.anchorsAfter}`);
      if (Array.isArray(data.styleErrors) && data.styleErrors.length) why.push(`${data.styleErrors.length} paragraph style error(s)`);
      if (data.oversetRollback) why.push("the write pushed text into overset (see mismatches)");
      return {
        success: false,
        error:
          `replace_paragraphs did not preserve the template (${why.join("; ")}); the edit was ` +
          `${((rb.data as Record<string, unknown>) ?? {}).rolledBack ? "rolled back with undo" : "NOT rolled back automatically — undo it"}`,
        data,
      };
    }
    if (r.success && data && data.oversetRollback) {
      // design-r3-03: a mismatch, not a failure — the story is restored and the caller records the mismatch.
      const rb = await rollbackIfNamed(bridge, args, "replace_paragraphs");
      const rolledBack = ((rb.data as Record<string, unknown>) ?? {}).rolledBack === true;
      data.revertedEdits = data.applied;
      data.applied = false;
      data.rolledBack = rolledBack;
      if (!rolledBack) {
        return { success: false, error: "replace_paragraphs: the write pushed text into overset but was NOT rolled back automatically — undo it", data };
      }
      return { success: true, data };
    }
    // autoFlow: if the write succeeded and the story overflows, automatically
    // call continueStory to add pages for the overflow text.
    if (autoFlow && r.success && !dryRun) {
      const flowArgs: Record<string, unknown> = { document_id: args.document_id, _noUndo: true };
      if (args.storyId !== undefined) flowArgs.storyId = args.storyId;
      if (args.frameId !== undefined) flowArgs.frameId = args.frameId;
      const flowR = await continueStory(bridge, flowArgs);
      const flowData = flowR.data as Record<string, unknown> | undefined;
      if (r.data && typeof r.data === "object") (r.data as Record<string, unknown>).autoFlow = flowR.data;
      if (!flowR.success || (flowData && flowData.blocker)) {
        const rb = await rollbackIfNamed(bridge, args, "replace_paragraphs");
        const rolledBack = ((rb.data as Record<string, unknown>) ?? {}).rolledBack === true;
        if (r.data && typeof r.data === "object") (r.data as Record<string, unknown>).rolledBack = rolledBack;
        return {
          success: false,
          error: `replace_paragraphs autoFlow: continue_story ${flowR.success ? "hit a blocker" : "failed"} — ${flowR.error || (flowData?.blocker as Record<string, unknown>)?.reasons || "unknown"}; the edit was ${rolledBack ? "rolled back" : "NOT rolled back — undo it"}`,
          data: r.data,
        };
      }
    }
    return r;
  });
}

/** Contact line types that have an icon in the BRAC templates. */
const CONTACT_TYPES = new Set(["address", "phone", "email", "web"]);
/** Types accepted in lines[] (fax has no template icon: it needs typeAliases or extraIcons). */
const LINE_TYPES = new Set(["address", "phone", "email", "web", "fax"]);
const WRAP_POLICIES = new Set(["mismatch", "warn", "hangingIndent"]);

function normalizeExtraIcons(v: unknown): { type: string; iconFrom: Record<string, number> }[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new Error("extraIcons must be an array of {type, iconFrom}");
  const seen = new Set<string>();
  return v.map((x, i): { type: string; iconFrom: Record<string, number> } => {
    const o = (x ?? {}) as Record<string, unknown>;
    const type = String(o.type ?? "").toLowerCase();
    if (!LINE_TYPES.has(type)) throw new Error(`extraIcons[${i}].type must be one of ${[...LINE_TYPES].join(", ")}`);
    if (seen.has(type)) throw new Error(`extraIcons has more than one entry for type '${type}'`);
    seen.add(type);
    const f = (o.iconFrom ?? {}) as Record<string, unknown>;
    if (f.pageItemId !== undefined && f.pageItemId !== null) {
      return { type, iconFrom: { pageItemId: Number(jsNum(f.pageItemId, `extraIcons[${i}].iconFrom.pageItemId`, { int: true })) } };
    }
    if (f.storyId !== undefined && f.storyId !== null) {
      return {
        type,
        iconFrom: {
          storyId: Number(jsNum(f.storyId, `extraIcons[${i}].iconFrom.storyId`, { int: true })),
          characterIndex: Number(jsNum(f.characterIndex, `extraIcons[${i}].iconFrom.characterIndex`, { int: true, min: 0 })),
        },
      };
    }
    throw new Error(`extraIcons[${i}].iconFrom needs {storyId, characterIndex} or {pageItemId}`);
  });
}

function normalizeTypeAliases(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("typeAliases must be an object such as {fax: 'phone'}");
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    const from = k.toLowerCase();
    const to = String(t ?? "").toLowerCase();
    if (!LINE_TYPES.has(from)) throw new Error(`typeAliases key '${k}' is not a contact type (${[...LINE_TYPES].join(", ")})`);
    if (!CONTACT_TYPES.has(to)) throw new Error(`typeAliases['${k}'] must be one of ${[...CONTACT_TYPES].join(", ")} (a type with a template icon)`);
    if (from === to) continue;
    out[from] = to;
  }
  return out;
}

async function replaceContactBlock(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    if (args.groupId === undefined && args.frameId === undefined) throw new Error("groupId or frameId is required");
    if (!Array.isArray(args.lines) || args.lines.length === 0) throw new Error("lines must be a non-empty array");
    const lines = (args.lines as unknown[]).map((l, i) => {
      const o = (l ?? {}) as Record<string, unknown>;
      const type = String(o.type ?? "").toLowerCase();
      const text = normalizeText(o.text);
      if (/[\r\n]/.test(text)) throw new Error(`lines[${i}].text must be a single line (one contact line per icon)`);
      return { type, text };
    });
    const extraIcons = normalizeExtraIcons(args.extraIcons);
    const typeAliases = normalizeTypeAliases(args.typeAliases);
    const wrapPolicy = args.wrapPolicy === undefined || args.wrapPolicy === null ? "mismatch" : String(args.wrapPolicy);
    if (!WRAP_POLICIES.has(wrapPolicy)) throw new Error(`wrapPolicy must be one of ${[...WRAP_POLICIES].join(", ")}`);
    const extraTypes = new Set((extraIcons ?? []).map((x) => x.type));
    const unknownTypes = lines
      .map((l) => (typeAliases && typeAliases[l.type]) || l.type)
      .filter((t) => !CONTACT_TYPES.has(t) && !extraTypes.has(t));
    const templateTypes = Array.isArray(args.templateTypes) ? (args.templateTypes as unknown[]).map((t) => String(t).toLowerCase()) : null;
    const dryRun = args.dryRun === true;
    const acceptGrep = args.acceptGrepEffects === true;
    if (args.allowOverset !== undefined && args.allowOverset !== null && typeof args.allowOverset !== "boolean") throw new Error("allowOverset must be a boolean");
    const autoFlow = args.autoFlow === true;
    const allowOverset = args.allowOverset === true || autoFlow;
    const paraArg = args.firstParagraphIndex ?? args.storyParagraphIndex;
    const scope = {
      blockIndex: args.blockIndex === undefined || args.blockIndex === null ? null : Number(jsNum(args.blockIndex, "blockIndex", { int: true, min: 0 })),
      paragraphIndex: paraArg === undefined || paraArg === null ? null : Number(jsNum(paraArg, "firstParagraphIndex", { int: true, min: 0 })),
    };
    const gid = jsNumOpt(args.groupId, "groupId", { int: true });
    const fid = jsNumOpt(args.frameId, "frameId", { int: true });
    const body = jsx`
      var st = __tp_contactStructure(doc, ${gid}, ${fid}, ${jsJson(scope)});
      var lines = ${jsJson(lines)};
      var override = ${jsJson(templateTypes)};
      var unknownTypes = ${jsJson(unknownTypes)};
      var aliases = ${jsJson(typeAliases)};
      var extras = ${jsJson(extraIcons)};
      var wrapPolicy = ${jsStr(wrapPolicy)};
      var acceptGrep = ${acceptGrep};
      var allowOverset = ${allowOverset};
      var res = { structure: st.kind, groupId: st.groupId || null, frameId: st.frameId, storyId: st.story.id, applied: false, mismatches: [], wrapPolicy: wrapPolicy, overrideErrors: [] };
      if (st.kind === 'inlineAnchors') { res.blockCount = st.blockCount; res.blockIndex = st.blockIndex === undefined ? null : st.blockIndex; res.firstParagraphIndex = st.firstParagraphIndex === undefined ? null : st.firstParagraphIndex; res.selectedBy = st.selectedBy || null; }
      if (st.blockMismatch) { res.mismatches.push(st.blockMismatch); res.dryRun = ${dryRun}; return __ok(res); }
      var tTypes = [], sTypes = [], eTypes = [];
      for (var i = 0; i < st.segs.length; i++) {
        tTypes.push(override ? override[i] : __tp_detectContactType(st.segs[i].text, st.icons[i] ? st.icons[i].name : ''));
      }
      res.aliasesUsed = [];
      for (var j = 0; j < lines.length; j++) {
        sTypes.push(lines[j].type);
        var eff = lines[j].type;
        if (aliases && aliases.hasOwnProperty(eff)) { eff = aliases[eff]; res.aliasesUsed.push({ line: j, from: lines[j].type, to: eff }); }
        eTypes.push(eff);
      }
      res.templateTypes = tTypes; res.sourceTypes = sTypes;
      if (res.aliasesUsed.length) res.effectiveTypes = eTypes;
      res.templateLines = [];
      for (var t = 0; t < st.segs.length; t++) res.templateLines.push({ text: st.segs[t].text.substring(st.segs[t].pre), iconId: st.icons[t] ? st.icons[t].id : null, iconName: st.icons[t] ? st.icons[t].name : '', paragraphIndex: st.segs[t].paragraphIndex === undefined ? null : st.segs[t].paragraphIndex });
      if (st.kind === 'group' && st.icons.length !== st.segs.length) res.mismatches.push({ reason: 'template group has ' + st.icons.length + ' icons but ' + st.segs.length + ' text lines' });
      if (override && override.length !== st.segs.length) res.mismatches.push({ reason: 'templateTypes has ' + override.length + ' entries but the template has ' + st.segs.length + ' lines' });
      if (unknownTypes.length) res.mismatches.push({ reason: 'unsupported contact type(s) with no icon in the template: ' + unknownTypes.join(', ') + ' (pass typeAliases, e.g. {fax:"phone"}, or extraIcons to add a line with an icon taken from another block)', templateTypes: tTypes, sourceTypes: sTypes });
      // Map source lines onto template lines; lines whose type the block lacks
      // can be ADDED when extraIcons supplies an icon for that type.
      var extraMap = {}, inTpl = {};
      for (var tt = 0; tt < tTypes.length; tt++) inTpl[tTypes[tt]] = true;
      if (extras) {
        if (st.kind !== 'inlineAnchors') res.mismatches.push({ reason: 'extraIcons is only supported for inline-anchor contact blocks (icons anchored in the text), not for a group of text frame + icon shapes' });
        for (var x = 0; x < extras.length; x++) {
          if (inTpl[extras[x].type]) { res.mismatches.push({ reason: 'extraIcons type ' + extras[x].type + ' is already a line of this template block; extraIcons only adds types the block lacks', templateTypes: tTypes }); continue; }
          extraMap[extras[x].type] = extras[x];
        }
      }
      var srcToTpl = [], adds = [], tk = 0, mapOk = true;
      for (var m0 = 0; m0 < eTypes.length; m0++) {
        if (tk < tTypes.length && eTypes[m0] === tTypes[tk]) { srcToTpl.push(tk); tk++; continue; }
        if (extraMap[eTypes[m0]]) { srcToTpl.push(-1); adds.push({ line: m0, type: eTypes[m0], afterTpl: tk - 1, spec: extraMap[eTypes[m0]] }); continue; }
        mapOk = false; break;
      }
      if (!mapOk || tk !== tTypes.length) {
        if (!unknownTypes.length) res.mismatches.push({ reason: 'line count or type order differs from the template', templateTypes: tTypes, sourceTypes: sTypes, effectiveTypes: eTypes });
        srcToTpl = null;
      }
      var tplToSrc = [];
      if (srcToTpl) for (var mm0 = 0; mm0 < srcToTpl.length; mm0++) if (srcToTpl[mm0] >= 0) tplToSrc[srcToTpl[mm0]] = mm0;
      for (var a0 = 0; a0 < adds.length; a0++) {
        var ad0 = adds[a0];
        if (ad0.afterTpl < 0) { res.mismatches.push({ reason: 'added ' + ad0.type + ' line ' + ad0.line + ' would be the first line of the block; an added line is inserted after an existing template line and takes its text formatting, so it cannot come first', line: ad0.line }); continue; }
        var src0 = __sc_iconSource(doc, ad0.spec.iconFrom);
        if (src0.error) { res.mismatches.push({ reason: 'extraIcons ' + ad0.type + ': ' + src0.error, line: ad0.line }); continue; }
        ad0.src = src0;
      }
      // GREP / nested styles keyed on ':' (e.g. '.+(?<=:)' -> Bold) would bold the new text up to its last colon.
      var grepWarn = [];
      if (srcToTpl) {
        for (var gm = 0; gm < lines.length; gm++) {
          var gk = srcToTpl[gm] >= 0 ? srcToTpl[gm] : null;
          if (gk === null) { for (var ga = 0; ga < adds.length; ga++) if (adds[ga].line === gm) gk = adds[ga].afterTpl; }
          if (gk === null || gk < 0) continue;
          var gseg = st.segs[gk], gpara = null, gsty = null;
          try { gpara = st.story.characters[gseg.a].paragraphs[0]; gsty = gpara.appliedParagraphStyle; } catch (eGp) {}
          if (!gpara) continue;
          var holder = {};
          var gr = __sc_grepGuard(gpara, gsty, gsty ? __tp_stylePath(gsty) : '?', gseg.text.substring(gseg.pre), lines[gm].text, acceptGrep, holder);
          if (gr) {
            var gmc = gr.extra && gr.extra.multiColon ? gr.extra.multiColon : null;
            var gm1 = { reason: gmc
                ? 'line ' + gm + ' ("' + __tp_trunc(lines[gm].text, 60) + '") has ' + gmc.colonCount + ' ":"; GREP ' + gmc.grepExpression + ' of ' + (gsty ? __tp_stylePath(gsty) : '?') + ' would bold up to the LAST ":", so the value part "' + gmc.valuePartBold + '" would be bold'
                : 'GREP/nested style of ' + (gsty ? __tp_stylePath(gsty) : '?') + ' would bold text up to ":" in line ' + gm, line: gm, text: lines[gm].text, detail: gr.err };
            if (gmc) gm1.multiColon = gmc;
            if (gr.extra && gr.extra.rules && gr.extra.rules.length) { gm1.grepExpression = gr.extra.rules[0].grepExpression || null; gm1.delimiter = gr.extra.rules[0].delimiter || null; gm1.characterStyle = gr.extra.rules[0].characterStyle; gm1.rules = gr.extra.rules; }
            gm1.hint = 'record the mismatch, or decide yourself to drop e.g. "https://" / a "Label:" prefix, or pass acceptGrepEffects:true';
            res.mismatches.push(gm1);
          } else if (holder.grepWarning) grepWarn.push('line ' + gm + ': ' + holder.grepWarning);
        }
      }
      if (adds.length) res.linesToAdd = (function () { var o = []; for (var q = 0; q < adds.length; q++) o.push({ line: adds[q].line, type: adds[q].type, afterTemplateLine: adds[q].afterTpl, iconFrom: adds[q].spec.iconFrom, iconKind: adds[q].src ? adds[q].src.kind : null, sourceIconSize: adds[q].src ? __sc_size(adds[q].src.bounds) : null }); return o; })();
      if (res.mismatches.length || ${dryRun}) {
        res.dryRun = ${dryRun}; if (grepWarn.length) res.warnings = grepWarn;
        // r4-B4: dryRun writes nothing, so line wraps / overset cannot be measured here.
        if (${dryRun}) res.notChecked = ['line wraps (wrapPolicy) and overset are measured only on the real run, which undoes the write and returns a mismatch if a line wraps or text is pushed into overset; pass wrapPolicy:"hangingIndent" up front if a long line may wrap'];
        return __ok(res);
      }
      var warn = grepWarn.slice(0);
      for (var cl = 0; cl < st.continued.length; cl++) warn.push('template line ' + st.continued[cl] + ' continued after a forced line break; it was replaced as one line');
      var story = st.story;
      var overBefore = null; try { overBefore = story.overflows; } catch (eo) {}
      var anchorsBefore = __tp_anchorCount(story);
      var before = __tp_contactPositions(st);
      // 1) Template lines, last to first.
      for (var k = st.segs.length - 1; k >= 0; k--) {
        __tp_writeAt(story, st.segs[k].a + st.segs[k].pre, st.segs[k].b, lines[tplToSrc[k]].text);
      }
      var scope2 = { blockIndex: null, paragraphIndex: st.kind === 'inlineAnchors' ? st.firstParagraphIndex : null };
      // 2) Added lines: duplicate an icon from another block + tab + text, after their template line.
      var addErrors = [], addedIcons = 0;
      res.linesAdded = [];
      if (adds.length) {
        var stW = __tp_contactStructure(doc, ${gid}, ${fid}, scope2);
        if (stW.blockMismatch) addErrors.push('could not re-read the block before adding lines: ' + stW.blockMismatch.reason);
        else {
          adds.sort(function (p, q) { return (q.afterTpl - p.afterTpl) || (q.line - p.line); });
          for (var ai = 0; ai < adds.length; ai++) {
            var ad = adds[ai], seg = stW.segs[ad.afterTpl];
            var txtNow = __tp_str(story.contents);
            var pos = seg.b;
            var sep = (pos < txtNow.length && txtNow.charAt(pos) === '\n') ? '\n' : '\r';
            var tplPara = story.characters[seg.a].paragraphs[0];
            var tplStyle = tplPara.appliedParagraphStyle;
            var tplSnap = __sc_snap(tplPara);
            var aBefore = __tp_anchorCount(story);
            __sc_insertAt(story, pos, sep);
            __sc_insertAt(story, pos + 1, '\t' + lines[ad.line].text);
            var dupOk = false, dupErr = null;
            if (ad.src.kind === 'character') {
              try { ad.src.ch.duplicate(LocationOptions.BEFORE, story.insertionPoints[pos + 1]); dupOk = true; }
              catch (eD1) { try { ad.src.ch.duplicate(LocationOptions.AFTER, story.characters[pos]); dupOk = true; } catch (eD2) { dupErr = String(eD2); } }
            } else {
              var dupItem = null;
              try {
                dupItem = ad.src.item.duplicate();
                dupItem.anchoredObjectSettings.insertAnchoredObject(story.insertionPoints[pos + 1], AnchorPosition.INLINE_POSITION);
                dupOk = true;
                // Same vertical offset and anchor-character formatting as the template line's icon.
                try { var tIcon = story.characters[seg.a]; var tItem = tIcon.allPageItems[0]; dupItem.anchoredObjectSettings.anchorYoffset = tItem.anchoredObjectSettings.anchorYoffset; __sc_copyFmt(tIcon, story.characters[pos + 1]); } catch (eY) {}
              } catch (eD3) { dupErr = String(eD3); try { if (dupItem && !dupOk) dupItem.remove(); } catch (eD4) {} }
            }
            var txtAfter = __tp_str(story.contents);
            var rec = { line: ad.line, type: ad.type, text: lines[ad.line].text, afterTemplateLine: ad.afterTpl, iconFrom: ad.spec.iconFrom, iconKind: ad.src.kind, separator: sep === '\r' ? 'paragraph' : 'forcedLineBreak' };
            if (!dupOk || txtAfter.charAt(pos + 1) !== '￼') { addErrors.push('line ' + ad.line + ': icon could not be duplicated' + (dupErr ? ' (' + dupErr + ')' : '')); res.linesAdded.push(rec); continue; }
            var nItem = null; try { nItem = story.characters[pos + 1].allPageItems[0]; } catch (eN) {}
            rec.newIconId = nItem ? nItem.id : null;
            rec.iconSize = nItem ? __sc_size(nItem.geometricBounds) : null;
            rec.sourceIconSize = __sc_size(ad.src.bounds);
            if (!rec.iconSize || !rec.sourceIconSize || Math.abs(rec.iconSize.width - rec.sourceIconSize.width) > 0.01 || Math.abs(rec.iconSize.height - rec.sourceIconSize.height) > 0.01) addErrors.push('line ' + ad.line + ': duplicated icon size ' + JSON.stringify(rec.iconSize) + ' differs from the source icon ' + JSON.stringify(rec.sourceIconSize));
            if (__tp_anchorCount(story) - aBefore !== 1) addErrors.push('line ' + ad.line + ': anchored-object count changed by ' + (__tp_anchorCount(story) - aBefore) + ' instead of 1');
            else addedIcons++;
            if (sep === '\r') {
              // New contact paragraph: same paragraph overrides as the template contact paragraph.
              var tp2 = story.characters[seg.a].paragraphs[0];
              __sc_ensureStyle(tp2, tplStyle); __sc_restore(tp2, tplSnap); __sc_verify(tp2, tplSnap, seg.paragraphIndex === undefined ? null : seg.paragraphIndex, res, 'template contact line ' + ad.afterTpl);
              var np2 = story.characters[pos + 1].paragraphs[0], fw2 = __sc_followerWant(tplSnap, tplStyle);
              __sc_ensureStyle(np2, tplStyle); __sc_restore(np2, fw2); __sc_verify(np2, fw2, seg.paragraphIndex === undefined ? null : seg.paragraphIndex + 1, res, 'added contact line ' + ad.line);
            }
            res.linesAdded.push(rec);
          }
        }
      }
      try { story.recompose(); } catch (e) {}
      var st2 = __tp_contactStructure(doc, ${gid}, ${fid}, scope2);
      var after = [];
      if (st2.blockMismatch) warn.push('could not re-read the contact block after writing: ' + st2.blockMismatch.reason);
      else after = __tp_contactPositions(st2);
      if (!st2.blockMismatch && after.length !== lines.length) addErrors.push('the block has ' + after.length + ' lines after writing, expected ' + lines.length);
      var storyOver = false; try { storyOver = st2.story.overflows; } catch (eOv) {}
      res.lines = [];
      var wrapped = [];
      for (var m = 0; m < after.length && m < lines.length; m++) {
        var tkm = srcToTpl[m], bef = tkm >= 0 ? before[tkm] : null;
        var shift = (bef && bef.delta !== null && after[m].delta !== null) ? __tp_round(after[m].delta - bef.delta) : null;
        res.lines.push({ type: sTypes[m], text: lines[m].text, added: tkm < 0, iconCenterY: after[m].iconCenterY, baseline: after[m].baseline, iconLineDeltaBefore: bef ? bef.delta : null, iconLineDeltaAfter: after[m].delta, shift: shift,
                         wraps: after[m].wraps, lineCount: after[m].lineCount, lineCountBefore: bef ? bef.lineCount : null, composed: after[m].composed, frameId: after[m].frameId });
        if (shift !== null && Math.abs(shift) > 2) warn.push('line ' + m + ' (' + sTypes[m] + ') moved ' + shift + 'pt relative to its icon (wrapped onto more lines?)');
        if (!after[m].composed) {
          if (storyOver) warn.push('line ' + m + ' (' + sTypes[m] + ') is overset: it is not composed in any frame and story ' + st2.story.id + ' overflows');
          else warn.push('line ' + m + ' (' + sTypes[m] + '): could not measure its composition (no parent text frame found, story does not overflow)');
        } else {
          if (after[m].baseline === null) warn.push('line ' + m + ' (' + sTypes[m] + '): could not measure baseline (frame ' + after[m].frameId + ')');
          if (after[m].partlyOverset) warn.push('line ' + m + ' (' + sTypes[m] + ') is partly overset (its last character is not composed)');
        }
        var wasSingle = bef ? !bef.wraps : true;
        if (after[m].wraps && wasSingle) wrapped.push(m);
      }
      // Wrapped icon lines (previously single-line): wrapPolicy decides.
      res.hangingIndentApplied = [];
      for (var w = 0; w < wrapped.length; w++) {
        var wm = wrapped[w], wseg = st2.segs[wm], wl = after[wm];
        var wtext = ''; try { wtext = wseg.text; } catch (eWt) {}
        var iconLine = wtext.charAt(0) === '￼';
        var wmsg = 'line ' + wm + ' (' + sTypes[wm] + ') now wraps onto ' + wl.lineCount + ' lines' + (iconLine ? ' under its icon' : '');
        if (wrapPolicy === 'warn') { warn.push(wmsg + (iconLine ? '; style has no hanging indent' : '')); continue; }
        var suggestion = 'shorten the line (your decision, e.g. drop "https://" or a "Label:" prefix), or call again with wrapPolicy:"hangingIndent" (indent the wrapped lines to the text) or wrapPolicy:"warn" (keep the wrap)';
        if (wrapPolicy === 'hangingIndent' && st2.kind === 'inlineAnchors' && iconLine) {
          var wp = st2.story.characters[wseg.a].paragraphs[0];
          var wps = wp.insertionPoints[0].index, wpe = wp.insertionPoints[-1].index;
          if (wps === wseg.a && (wpe === wseg.b || wpe === wseg.b + 1)) {
            var L0 = wp.leftIndent, F0 = wp.firstLineIndent, hang = null, method = 'measured';
            try { var ix0 = st2.story.characters[wseg.a].horizontalOffset, tx0 = st2.story.characters[wseg.a + wseg.pre].horizontalOffset; if (tx0 > ix0) hang = tx0 - ix0; } catch (eH) {}
            if (hang === null) {
              method = 'iconWidth+firstTabStop';
              var iw = 0; try { var ib = st2.icons[wm].bounds; iw = ib[3] - ib[1]; } catch (eIw) {}
              var tab0 = 0; try { if (wp.tabStops.length) tab0 = wp.tabStops[0].position; } catch (eTb) {}
              hang = iw + tab0;
            }
            if (hang > 0) {
              wp.leftIndent = L0 + F0 + hang;
              wp.firstLineIndent = -hang;
              try { st2.story.recompose(); } catch (eRc) {}
              var lcA = null; try { lcA = __sc_lineInfo(st2.story, wseg).lineCount; } catch (eLc) {}
              res.hangingIndentApplied.push({ line: wm, paragraphIndex: wseg.paragraphIndex === undefined ? null : wseg.paragraphIndex, method: method, hangingIndent: __tp_round(hang),
                                             leftIndent: { from: __tp_round(L0), to: __tp_round(L0 + F0 + hang) }, firstLineIndent: { from: __tp_round(F0), to: __tp_round(-hang) }, lineCount: lcA });
              warn.push(wmsg + '; hanging indent ' + __tp_round(hang) + 'pt applied to that paragraph only (wrapPolicy hangingIndent)');
              continue;
            }
          }
          res.mismatches.push({ reason: wmsg + ' and a hanging indent cannot be applied to it alone (it shares its paragraph with other lines through forced line breaks, or the text offset could not be measured)', line: wm, text: lines[wm].text, frameWidth: wl.frameWidth, lineCount: wl.lineCount, suggestion: suggestion });
          res.wrapRollback = true;
          continue;
        }
        res.mismatches.push({ reason: wmsg + ' (wrapPolicy ' + wrapPolicy + ')', line: wm, text: lines[wm].text, frameId: wl.frameId, frameWidth: wl.frameWidth, lineCount: wl.lineCount, suggestion: suggestion });
        res.wrapRollback = true;
      }
      // qa-r3-01: a contact line composed before the write that is overset (or
      // partly overset) now = hidden text. Measured AFTER any hanging indent.
      res.oversetLines = [];
      if (!st2.blockMismatch) {
        var afterO = after;
        if (res.hangingIndentApplied.length) { try { st2.story.recompose(); } catch (eRo) {} afterO = __tp_contactPositions(st2); }
        for (var om = 0; om < afterO.length && om < lines.length; om++) {
          var otk = srcToTpl[om], obef = null;
          if (otk >= 0) obef = before[otk];
          else { for (var oa = 0; oa < adds.length; oa++) if (adds[oa].line === om && adds[oa].afterTpl >= 0) obef = before[adds[oa].afterTpl]; }
          if (!obef || !obef.composed || obef.partlyOverset) continue;
          var oaf = afterO[om];
          if (oaf.composed && !oaf.partlyOverset) continue;
          res.oversetLines.push({ line: om, type: sTypes[om], text: lines[om].text, added: otk < 0, frameId: obef.frameId, frameIdAfter: oaf.frameId, partlyOverset: !!oaf.composed,
                                  lineCountBefore: obef.lineCount, hangingIndentApplied: res.hangingIndentApplied.length > 0 });
        }
      }
      var newlyOver = false; try { newlyOver = st2.story.overflows === true && overBefore === false; } catch (eNo) {}
      if (res.oversetLines.length || newlyOver) {
        if (allowOverset) warn.push('overset text kept because allowOverset:true' + (res.oversetLines.length ? ' (lines ' + (function () { var o = []; for (var q = 0; q < res.oversetLines.length; q++) o.push(res.oversetLines[q].line); return o.join(', '); })() + ')' : ''));
        else {
          for (var ol = 0; ol < res.oversetLines.length; ol++) {
            var olr = res.oversetLines[ol];
            res.mismatches.push({ line: olr.line, reason: 'pushed into overset', detail: 'line ' + olr.line + ' (' + olr.type + ') was composed in frame ' + olr.frameId + ' before the write and is ' + (olr.partlyOverset ? 'partly overset' : 'overset') + ' now' +
                                  (olr.hangingIndentApplied ? ' (still, after the hanging indent)' : '') + ' (wrapPolicy ' + wrapPolicy + '); the write was undone',
                                  text: olr.text, frameId: olr.frameId, partlyOverset: olr.partlyOverset,
                                  suggestion: 'shorten the line(s) (your decision), make room in / thread the frame, or call again with allowOverset:true to keep the overset text' });
          }
          if (!res.oversetLines.length) res.mismatches.push({ line: null, reason: 'pushed into overset', detail: 'story ' + st2.story.id + ' did not overflow before the write and does now (text after the contact block is hidden); the write was undone', frameId: st2.frameId,
                                                             suggestion: 'shorten the line(s) (your decision), make room in / thread the frame, or call again with allowOverset:true to keep the overset text' });
          res.oversetRollback = true;
        }
      }
      res.applied = true;
      res.storyOverflows = st2.story.overflows;
      if (res.storyOverflows && overBefore === false) warn.push('story ' + st2.story.id + ' now overflows (overset text) and did not before this call');
      res.warnings = warn;
      res.anchorsBefore = anchorsBefore;
      res.anchorsAfter = __tp_anchorCount(st2.story);
      res.iconsAdded = addedIcons;
      if (addErrors.length) res.addErrors = addErrors;
      res.verificationFailed = res.anchorsAfter !== anchorsBefore + addedIcons || addErrors.length > 0;
      // qa-r3-01: hidden (overset) text also forces the undo; the handler reports it as a mismatch (applied:false, rolledBack:true).
      res.rollbackRequired = res.verificationFailed || res.oversetRollback === true;
      return __ok(res);`;
    const r = await runTp(bridge, args, body, {
      prelude: REPLACE_PARAGRAPHS_JSX + CONTACT_JSX,
      undoName: dryRun ? undefined : "replace_contact_block",
      mutating: !dryRun,
    });
    const data = r.data as Record<string, unknown> | undefined;
    if (r.success && data && data.rollbackRequired && data.verificationFailed) {
      const rb = await rollbackIfNamed(bridge, args, "replace_contact_block");
      const why: string[] = [];
      if (data.anchorsAfter !== (Number(data.anchorsBefore) + Number(data.iconsAdded ?? 0))) {
        why.push(`anchored-object count ${data.anchorsBefore} -> ${data.anchorsAfter} (expected +${Number(data.iconsAdded ?? 0)} added icon(s))`);
      }
      if (Array.isArray(data.addErrors) && data.addErrors.length) why.push(`${data.addErrors.length} added-line error(s) (see addErrors)`);
      if (data.oversetRollback) why.push("contact text pushed into overset (see mismatches)");
      return {
        success: false,
        error: `replace_contact_block did not preserve the template (${why.join("; ") || "verification failed"}); ${((rb.data as Record<string, unknown>) ?? {}).rolledBack ? "rolled back with undo" : "NOT rolled back automatically — undo it"}`,
        data,
      };
    }
    if (r.success && data && (data.wrapRollback || data.oversetRollback)) {
      // A mismatch, not a failure: the block is restored and the caller records the mismatch.
      const rb = await rollbackIfNamed(bridge, args, "replace_contact_block");
      const rolledBack = ((rb.data as Record<string, unknown>) ?? {}).rolledBack === true;
      data.applied = false;
      data.rolledBack = rolledBack;
      if (!rolledBack) {
        return { success: false, error: `replace_contact_block: ${data.oversetRollback ? "contact text was pushed into overset" : "a contact line now wraps (wrapPolicy mismatch)"} but the edit was NOT rolled back automatically — undo it`, data };
      }
      return { success: true, data };
    }
    // autoFlow: if the write succeeded and the story overflows, automatically
    // call continueStory to add pages for the overflow text.
    if (autoFlow && r.success && !dryRun) {
      const flowArgs: Record<string, unknown> = { document_id: args.document_id, _noUndo: true };
      if (args.storyId !== undefined) flowArgs.storyId = args.storyId;
      else if (data && data.storyId !== undefined) flowArgs.storyId = data.storyId;
      if (args.frameId !== undefined) flowArgs.frameId = args.frameId;
      else if (data && data.frameId !== undefined) flowArgs.frameId = data.frameId;
      const flowR = await continueStory(bridge, flowArgs);
      const flowData = flowR.data as Record<string, unknown> | undefined;
      if (data) data.autoFlow = flowR.data;
      if (!flowR.success || (flowData && flowData.blocker)) {
        const rb = await rollbackIfNamed(bridge, args, "replace_contact_block");
        const rolledBack = ((rb.data as Record<string, unknown>) ?? {}).rolledBack === true;
        if (data) data.rolledBack = rolledBack;
        return {
          success: false,
          error: `replace_contact_block autoFlow: continue_story ${flowR.success ? "hit a blocker" : "failed"} — ${flowR.error || (flowData?.blocker as Record<string, unknown>)?.reasons || "unknown"}; the edit was ${rolledBack ? "rolled back" : "NOT rolled back — undo it"}`,
          data: r.data,
        };
      }
    }
    return r;
  });
}

// ── verify_page_invariants ──────────────────────────────────────────────────

interface PageReport {
  pageIndex: number;
  name: string;
  anchoredCount: number;
  styleSequence: string[];
  gaps: { aId: number; bId: number; gap: number }[];
  textOutsideMargins: unknown[];
  overlaps: unknown[];
  emptyFrameOverlaps: unknown[];
  placeholderHits: unknown[];
  oversetStories: unknown[];
  masterIssues: unknown[];
  [k: string]: unknown;
}

function diffBaseline(current: { pageCount: number; pages: PageReport[] }, baseline: unknown, gapTolerance: number) {
  const b = baseline as { pageCount?: number; pages?: PageReport[] } | undefined;
  if (!b || !Array.isArray(b.pages)) return { error: "baseline must be the data object returned by a previous verify_page_invariants call" };
  const diff: Record<string, unknown> = {};
  const problems: string[] = [];
  if (typeof b.pageCount === "number" && b.pageCount !== current.pageCount) {
    diff.pageCount = { before: b.pageCount, after: current.pageCount };
    problems.push(`page count changed ${b.pageCount} -> ${current.pageCount}`);
  }
  const perPage: unknown[] = [];
  for (const p of current.pages) {
    const bp = b.pages.find((x) => x.pageIndex === p.pageIndex);
    if (!bp) { perPage.push({ pageIndex: p.pageIndex, note: "page not in baseline" }); continue; }
    const d: Record<string, unknown> = { pageIndex: p.pageIndex, name: p.name };
    if (bp.anchoredCount !== p.anchoredCount) {
      d.anchoredCount = { before: bp.anchoredCount, after: p.anchoredCount };
      problems.push(`page ${p.name}: anchored objects ${bp.anchoredCount} -> ${p.anchoredCount}`);
    }
    if (JSON.stringify(bp.styleSequence) !== JSON.stringify(p.styleSequence)) {
      d.styleSequence = { before: bp.styleSequence, after: p.styleSequence };
      problems.push(`page ${p.name}: paragraph style sequence changed`);
    }
    const gapDeltas: unknown[] = [];
    for (const g of p.gaps) {
      const bg = bp.gaps.find((x) => x.aId === g.aId && x.bId === g.bId);
      if (!bg) continue;
      const delta = Math.round((g.gap - bg.gap) * 1000) / 1000;
      if (Math.abs(delta) > gapTolerance) {
        gapDeltas.push({ aId: g.aId, bId: g.bId, before: bg.gap, after: g.gap, delta });
        problems.push(`page ${p.name}: gap ${g.aId}->${g.bId} changed by ${delta}pt`);
      }
    }
    const lostPairs = bp.gaps.filter((x) => !p.gaps.some((g) => g.aId === x.aId && g.bId === x.bId));
    if (gapDeltas.length) d.gapDeltas = gapDeltas;
    if (lostPairs.length) d.stackChanged = lostPairs.map((x) => `${x.aId}->${x.bId}`);
    if (Object.keys(d).length > 2) perPage.push(d);
  }
  diff.pages = perPage;
  return { problems, diff };
}

async function verifyPageInvariants(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    if (!Array.isArray(args.pageIndexes) || args.pageIndexes.length === 0) throw new Error("pageIndexes (0-based document offsets) is required");
    if (args.pageIndexes.length > 16) throw new Error("at most 16 pages per call");
    const pages = (args.pageIndexes as unknown[]).map((p, i) => Number(jsNum(p, `pageIndexes[${i}]`, { int: true, min: 0 })));
    const prefixes = Array.isArray(args.excludeNamePrefixes)
      ? (args.excludeNamePrefixes as unknown[]).map((s) => String(s).toLowerCase())
      : ["bleed"];
    const tol = args.marginTolerance !== undefined ? Number(jsNum(args.marginTolerance, "marginTolerance", { min: 0 })) : 0.5;
    const checkThreading = args.checkThreading === true;
    const body = jsx`
      var pageIdx = ${jsJson(pages)}, prefixes = ${jsJson(prefixes)}, tol = ${tol}, checkThreading = ${checkThreading};
      var PH_RE = /Lorem|ipsum|dolor sit/i;
      function excluded(item) {
        var nm = String(item.name || '').toLowerCase();
        for (var i = 0; i < prefixes.length; i++) if (prefixes[i] && nm.indexOf(prefixes[i]) === 0) return 'namePrefix';
        try { if (item.itemLayer.locked) return 'lockedLayer'; if (/bleed/i.test(item.itemLayer.name)) return 'bleedLayer'; } catch (e) {}
        if (__tp_isMasterOverride(item)) return 'masterItem';
        return null;
      }
      function hasText(item) {
        var t = __tp_type(item);
        if (t === 'TextFrame') return true;
        if (t === 'Group') { try { var a = item.allPageItems; for (var i = 0; i < a.length; i++) if (__tp_type(a[i]) === 'TextFrame') return true; } catch (e) {} }
        return false;
      }
      // An empty text frame used as background/placeholder: no characters in its
      // own text, and either no fill or an empty story.
      function emptyFrame(item) {
        if (__tp_type(item) !== 'TextFrame') return false;
        var n = 0; try { n = item.texts[0].characters.length; } catch (e) { n = 0; }
        if (n > 0) return false;
        var fillNone = false; try { fillNone = String(item.fillColor.name) === 'None'; } catch (e2) {}
        var storyEmpty = false; try { storyEmpty = item.parentStory.characters.length === 0; } catch (e3) {}
        return fillNone || storyEmpty;
      }
      // Text frames this page shows from its master(s) (non-overridden items).
      function masterTextFrames(page) {
        var items = null, out = [];
        try { items = page.masterPageItems; } catch (e) { items = null; }
        if (items === null || items === undefined) {
          items = [];
          try {
            var m = page.appliedMaster, guard = 0, side = __tp_side(page);
            while (m && __tp_valid(m) && guard++ < 10) {
              var mp = m.pages, mpg = (mp.length > 1 && side === 'right') ? mp[1] : mp[0];
              var ma = mpg.allPageItems;
              for (var i = 0; i < ma.length; i++) items.push(ma[i]);
              var nx = null; try { nx = m.appliedMaster; } catch (e2) { nx = null; }
              m = nx;
            }
          } catch (e3) {}
        } else {
          var flat = [];
          for (var j = 0; j < items.length; j++) {
            var it0 = __tp_concrete(items[j]);
            flat.push(it0);
            try { var sub = it0.allPageItems; for (var s = 0; s < sub.length; s++) flat.push(sub[s]); } catch (e4) {}
          }
          items = flat;
        }
        for (var k = 0; k < items.length; k++) if (__tp_type(items[k]) === 'TextFrame') out.push(items[k]);
        return out;
      }
      function masterName(tf, page) {
        try { var pp = tf.parentPage; if (pp && pp.parent && pp.parent.name) return String(pp.parent.name); } catch (e) {}
        try { return String(page.appliedMaster.name); } catch (e2) {}
        return '?';
      }
      function rel(page, b) { var r = __tp_spreadToPage(page, b); return [__tp_round(r[0]), __tp_round(r[1]), __tp_round(r[2]), __tp_round(r[3])]; }
      var out = { pageCount: doc.pages.length, pages: [] };
      var seenMasterFrames = {};
      for (var pi = 0; pi < pageIdx.length; pi++) {
        var page = __tp_requirePage(doc, pageIdx[pi]);
        var mb = __tp_marginBox(page), pb = page.bounds;
        var rep = __tp_pageInfo(page);
        rep.pageIndex = pageIdx[pi];
        rep.marginBox = rel(page, mb);
        rep.textOutsideMargins = []; rep.otherOutsideMargins = []; rep.overlaps = []; rep.emptyFrameOverlaps = []; rep.placeholderHits = [];
        rep.oversetStories = []; rep.masterIssues = []; rep.anchoredCount = 0; rep.styleSequence = []; rep.gaps = []; rep.excluded = [];
        var top = page.pageItems, cands = [], stack = [];
        for (var i = 0; i < top.length; i++) {
          var it = __tp_concrete(top[i]);
          var ex = excluded(it);
          var b = it.geometricBounds;
          if (ex) { rep.excluded.push({ id: it.id, name: it.name || '', reason: ex }); continue; }
          var ht = hasText(it);
          var over = { top: __tp_round(mb[0] - b[0]), left: __tp_round(mb[1] - b[1]), bottom: __tp_round(b[2] - mb[2]), right: __tp_round(b[3] - mb[3]) };
          if (over.top > tol || over.left > tol || over.bottom > tol || over.right > tol) {
            var rec = { id: it.id, name: it.name || '', type: __tp_type(it), bounds: rel(page, b), overBy: over };
            if (ht) rep.textOutsideMargins.push(rec); else rep.otherOutsideMargins.push(rec);
          }
          var entry = { id: it.id, b: b, text: ht, empty: ht && emptyFrame(it) };
          if (ht) cands.push(entry);
          if (b[2] > pb[0] && b[0] < pb[2]) stack.push(entry);
        }
        for (var a = 0; a < cands.length; a++) for (var c = a + 1; c < cands.length; c++) {
          var A = cands[a].b, B = cands[c].b;
          var ow = Math.min(A[3], B[3]) - Math.max(A[1], B[1]), oh = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
          if (ow > 1 && oh > 1) {
            var ovl = { aId: cands[a].id, bId: cands[c].id, overlapWidth: __tp_round(ow), overlapHeight: __tp_round(oh) };
            if (cands[a].empty || cands[c].empty) { ovl.emptyFrameId = cands[a].empty ? cands[a].id : cands[c].id; rep.emptyFrameOverlaps.push(ovl); }
            else rep.overlaps.push(ovl);
          }
        }
        stack.sort(function (x, y) { return x.b[0] - y.b[0]; });
        for (var s = 0; s < stack.length; s++) {
          var best = null;
          for (var t2 = 0; t2 < stack.length; t2++) {
            if (t2 === s) continue;
            var X = stack[s].b, Y = stack[t2].b;
            if (Y[0] < X[2] - 1) continue;
            if (Math.min(X[3], Y[3]) - Math.max(X[1], Y[1]) <= 1) continue;
            if (!best || Y[0] < best.b[0]) best = stack[t2];
          }
          if (best) rep.gaps.push({ aId: stack[s].id, bId: best.id, gap: __tp_round(best.b[0] - stack[s].b[2]) });
        }
        var all = page.allPageItems, frames = [], stories = {};
        for (var f = 0; f < all.length; f++) if (__tp_type(all[f]) === 'TextFrame') frames.push(all[f]);
        frames.sort(function (x, y) { var bx = x.geometricBounds, by = y.geometricBounds; return (bx[0] - by[0]) || (bx[1] - by[1]); });
        for (var g = 0; g < frames.length; g++) {
          var tf = frames[g];
          var txt = '';
          try { txt = __tp_str(tf.texts[0].contents); } catch (e) {}
          rep.anchoredCount += __tp_count(txt, '￼');
          var mt = txt.match(PH_RE);
          if (mt) { var at = txt.search(PH_RE); rep.placeholderHits.push({ frameId: tf.id, snippet: txt.substring(Math.max(0, at - 20), at + 40) }); }
          var sto = tf.parentStory;
          if (sto.overflows && !stories[sto.id]) { stories[sto.id] = true; rep.oversetStories.push({ storyId: sto.id, frameId: tf.id, grouped: __tp_type(tf.parent) === 'Group' }); }
          if (__tp_isAnchored(tf)) continue;
          try {
            var ps = __tp_arr(tf.paragraphs.everyItem().appliedParagraphStyle);
            for (var q = 0; q < ps.length; q++) rep.styleSequence.push(__tp_stylePath(ps[q]));
          } catch (e2) {}
        }
        // Threading check: flag non-anchored content frames that belong to a
        // single-frame (unthreaded) story — required for every chapter content frame.
        rep.unthreadedFrames = [];
        if (checkThreading) {
          for (var uf = 0; uf < frames.length; uf++) {
            var tfU = frames[uf];
            if (__tp_isAnchored(tfU)) continue;
            var stoU = tfU.parentStory, cntU = 0, chU = 0;
            try { cntU = stoU.textContainers.length; } catch (e6) {}
            try { chU = stoU.characters.length; } catch (e7) {}
            if (cntU === 1 && chU > 0) rep.unthreadedFrames.push({ frameId: tfU.id, storyId: stoU.id, charCount: chU });
          }
        }
        // Master-page text (running heads, folios): overset and placeholder text.
        // Each master frame is reported once per call (on the first page showing it).
        var mfs = masterTextFrames(page);
        for (var mi = 0; mi < mfs.length; mi++) {
          var mf = mfs[mi];
          if (seenMasterFrames[mf.id]) continue;
          seenMasterFrames[mf.id] = true;
          var mn = masterName(mf, page), msid = null;
          try { msid = mf.parentStory.id; } catch (e3) {}
          var ref = 'master:' + mn + ' frame ' + mf.id + ' story ' + msid;
          var mover = false; try { mover = mf.overflows === true || mf.parentStory.overflows === true; } catch (e4) {}
          if (mover) rep.masterIssues.push({ ref: ref, masterName: mn, frameId: mf.id, storyId: msid, issue: 'overset' });
          var mtx = ''; try { mtx = __tp_str(mf.texts[0].contents); } catch (e5) {}
          var mat = mtx.search(PH_RE);
          if (mat >= 0) rep.masterIssues.push({ ref: ref, masterName: mn, frameId: mf.id, storyId: msid, issue: 'placeholder', snippet: mtx.substring(Math.max(0, mat - 20), mat + 40) });
        }
        out.pages.push(rep);
      }
      return __ok(out);`;
    const r = await runTp(bridge, args, body);
    if (!r.success || !r.data) return r;
    const data = r.data as { pageCount: number; pages: PageReport[] };
    const summary = data.pages.map((p) => ({
      pageIndex: p.pageIndex,
      name: p.name,
      textOutsideMargins: p.textOutsideMargins.length,
      overlaps: p.overlaps.length,
      emptyFrameOverlaps: (p.emptyFrameOverlaps ?? []).length,
      placeholderHits: p.placeholderHits.length,
      oversetStories: p.oversetStories.length,
      masterIssues: (p.masterIssues ?? []).length,
      unthreadedFrames: ((p.unthreadedFrames as unknown[]) ?? []).length,
    }));
    // emptyFrameOverlaps are informational and do not affect ok.
    const ok = summary.every((s) => !s.textOutsideMargins && !s.overlaps && !s.placeholderHits && !s.oversetStories && !s.masterIssues && (!checkThreading || !s.unthreadedFrames));
    const result: Record<string, unknown> = { ok, summary, ...data };
    if (args.baseline !== undefined) {
      const gapTol = args.gapTolerance !== undefined ? Number(args.gapTolerance) : 6;
      const d = diffBaseline(data, args.baseline, gapTol);
      result.baselineDiff = d;
      if ("error" in d || ("problems" in d && d.problems && d.problems.length)) result.ok = false;
    }
    return { success: true, data: result };
  });
}

// ── continue_story ───────────────────────────────────────────────────────────

export async function continueStory(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    if (args.storyId === undefined && args.frameId === undefined) {
      throw new Error("storyId (or frameId of a frame in the story) is required; continue_story only threads that story's overflow");
    }
    const maxPages = args.maxPages !== undefined ? Number(jsNum(args.maxPages, "maxPages", { int: true, min: 1, max: 20 })) : 20;
    const geometry = args.frameGeometry === "lastFrame" ? "lastFrame" : "margins";
    const body = jsx`
      var story = __tp_requireStory(doc, ${jsNumOpt(args.storyId, "storyId", { int: true })}, ${jsNumOpt(args.frameId, "frameId", { int: true })});
      var t0 = __tp_now(), guardMs = 90000, maxPages = ${maxPages}, allowCross = ${args.allowCrossSection === true}, allowRowBreak = ${args.allowRowBreak === true};
      var conts = story.textContainers;
      if (!conts.length) return __fail('story ' + story.id + ' has no text frames');
      var last = conts[conts.length - 1];
      if (__tp_type(last) !== 'TextFrame') return __fail('last container of story ' + story.id + ' is a ' + __tp_type(last) + ', not a text frame');
      var res = { storyId: story.id, pagesAdded: [], framesAdded: [], warnings: [] };
      story.recompose();
      if (!story.overflows) { res.storyOverflows = false; res.message = 'story is not overset; nothing to do'; return __ok(res); }
      var master = null;
      var masterName = ${args.masterName ? jsStr(args.masterName) : "null"};
      if (masterName !== null) { master = doc.masterSpreads.itemByName(masterName); if (!__tp_valid(master)) return __fail('master spread not found: ' + masterName); }
      if (!last.parentPage) return __fail('the last frame of story ' + story.id + ' is on the pasteboard');
      if (__tp_type(last.parentPage.parent) === 'MasterSpread') return __fail('story ' + story.id + ' ends on a master spread');
      var rowBreakTried = {};
      while (story.overflows) {
        if (res.pagesAdded.length >= maxPages) { res.warnings.push('stopped after maxPages=' + maxPages + '; story still overset'); break; }
        if (__tp_now() - t0 > guardMs) { res.partial = true; res.warnings.push('stopped by the 90 s wall-clock guard; call again to continue'); break; }
        // Track last composed character index to detect no-progress loops
        // (e.g. table header rows repeat on new pages but no body rows flow).
        var __lastComposedIdx = -1;
        try { var __tcs = story.textContainers; for (var __ti = __tcs.length - 1; __ti >= 0; __ti--) { try { var __tcC = __tcs[__ti].characters; if (__tcC.length > 0) { __lastComposedIdx = __tcC[-1].index; break; } } catch (e) {} } } catch (e) {}
        var lp = last.parentPage;
        var nextIdx = lp.documentOffset + 1;
        if (nextIdx < doc.pages.length) {
          var nxt = doc.pages[nextIdx];
          var sameSec = true;
          try { sameSec = nxt.appliedSection.id === lp.appliedSection.id; } catch (e) {}
          if (!sameSec) {
            res.nextSectionStart = __tp_pageInfo(nxt);
            if (!allowCross) {
              res.error = 'the next page (' + nxt.name + ', offset ' + nxt.documentOffset + ') starts another section; inserting here pushes that section. Pass allowCrossSection:true to confirm.';
              break;
            }
          }
        }
        var np = doc.pages.add(LocationOptions.AFTER, lp);
        try { if (np.appliedSection.id !== lp.appliedSection.id && !allowCross) { np.remove(); res.error = 'new page landed in a different section'; break; } } catch (e) {}
        try { np.appliedMaster = master ? master : lp.appliedMaster; } catch (e) { res.warnings.push('could not apply master: ' + e); }
        var bounds;
        if (${jsStr(geometry)} === 'lastFrame') {
          var r = __tp_spreadToPage(lp, last.geometricBounds);
          var sl = __tp_side(lp), sn = __tp_side(np);
          if ((sl === 'left' || sl === 'right') && (sn === 'left' || sn === 'right') && sl !== sn) {
            var w = lp.bounds[3] - lp.bounds[1];
            r = [r[0], w - r[3], r[2], w - r[1]];
          }
          bounds = __tp_pageToSpread(np, r);
        } else {
          bounds = __tp_marginBox(np);
        }
        var nf = np.textFrames.add();
        try { nf.itemLayer = last.itemLayer; } catch (e) {}
        try { nf.appliedObjectStyle = last.appliedObjectStyle; } catch (e) {}
        nf.geometricBounds = bounds;
        var sp = last.textFramePreferences, dp = nf.textFramePreferences;
        var props = ['textColumnCount', 'textColumnGutter', 'insetSpacing', 'verticalJustification', 'firstBaselineOffset', 'ignoreWrap', 'useNoLineBreaksForAutoSizing'];
        for (var pp = 0; pp < props.length; pp++) { try { dp[props[pp]] = sp[props[pp]]; } catch (e) {} }
        try { dp.autoSizingType = AutoSizingTypeEnum.OFF; } catch (e) {}
        last.nextTextFrame = nf;
        story.recompose();
        if (nf.characters.length === 0) {
          // Diagnose BEFORE removing the frame, so the blocker is measured against it.
          var diag = null;
          try { diag = __sc_flowBlocker(story, nf, np); } catch (eD) { diag = { report: { reasons: ['diagnosis failed: ' + (eD && eD.message ? eD.message : eD)] }, table: null }; }
          var flowed = false;
          if (allowRowBreak && diag.table && !rowBreakTried[diag.table.id]) {
            rowBreakTried[diag.table.id] = true;
            var rx = __sc_relaxRows(diag.table);
            diag.report.allowRowBreakTried = true;
            if (rx.changes.length) {
              story.recompose();
              if (nf.characters.length > 0) {
                flowed = true;
                res.rowBreakChanges = (res.rowBreakChanges || []).concat([{ tableId: diag.table.id, changes: rx.changes }]);
                res.warnings.push('allowRowBreak: changed ' + rx.changes.length + ' row keep option(s) on table ' + diag.table.id + ' so it could flow (see rowBreakChanges)');
              } else {
                __sc_revertRows(diag.table, rx.raw);
                story.recompose();
                diag.report.allowRowBreakResult = 'relaxing ' + rx.changes.length + ' row keep option(s) did not help; reverted';
              }
            } else diag.report.allowRowBreakResult = 'no row keep options to relax';
          }
          if (!flowed) {
            last.nextTextFrame = NothingEnum.NOTHING;
            nf.remove(); np.remove();
            res.blocker = diag.report;
            res.mismatch = { reason: 'overset text of story ' + story.id + ' cannot flow into a fresh frame; text stays overset (hidden) until the blocker is fixed', blocker: diag.report };
            res.error = 'overset text did not flow into a fresh frame: ' + diag.report.reasons.join('; ') + '. Nothing was added for this step; see data.blocker';
            break;
          }
        }
        // No-progress detection: if the story still overflows and the last
        // composed character index did not advance, the new page only shows
        // repeated table headers with no body rows. Remove it to prevent
        // an infinite loop of empty-looking table pages.
        if (nf.characters.length > 0 && story.overflows) {
          var __newLastIdx = -1;
          try { var __tcs2 = story.textContainers; for (var __ti2 = __tcs2.length - 1; __ti2 >= 0; __ti2--) { try { var __tc2 = __tcs2[__ti2].characters; if (__tc2.length > 0) { __newLastIdx = __tc2[-1].index; break; } } catch (e) {} } } catch (e) {}
          if (__newLastIdx >= 0 && __lastComposedIdx >= 0 && __newLastIdx <= __lastComposedIdx) {
            last.nextTextFrame = NothingEnum.NOTHING;
            nf.remove(); np.remove();
            res.blocker = { reasons: ['table header rows repeat on new pages but no body rows fit the frame height; adding more pages creates empty-looking pages (no new content composed)'] };
            res.mismatch = { reason: 'no new content flowed into the added page; table headers repeat without body rows. Page removed to prevent empty table pages.', blocker: res.blocker };
            res.error = 'no new content flowed: table header rows repeat but body rows are too tall for the frame; page removed. See data.blocker';
            break;
          }
        }
        var info = __tp_pageInfo(np);
        info.frameId = nf.id;
        info.frameBounds = __tp_spreadToPage(np, nf.geometricBounds);
        res.pagesAdded.push(info);
        res.framesAdded.push(nf.id);
        last = nf;
      }
      res.storyOverflows = story.overflows;
      res.frameCount = story.textContainers.length;
      res.elapsedMs = __tp_now() - t0;
      if (doc.documentPreferences.facingPages && res.pagesAdded.length % 2 === 1) {
        res.warnings.push('facing-parity: an odd number of pages (' + res.pagesAdded.length + ') was inserted, so every later page switched left/right side. Chapter openers after offset ' + res.pagesAdded[res.pagesAdded.length - 1].documentOffset + ' may now be on the wrong side; add or remove one page in this chapter.');
        res.parityFlipped = true;
      }
      return __ok(res);`;
    const skipUndo = (args as Record<string, unknown>)._noUndo === true;
    const r = await runTp(bridge, args, body, { prelude: CONTINUE_JSX, undoName: skipUndo ? undefined : "continue_story", mutating: true });
    const d = r.data as Record<string, unknown> | undefined;
    if (r.success && d && d.error) return { success: false, error: String(d.error), data: d };
    return r;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export const CONTINUE_STORY_SCHEMA = {
  type: "object" as const,
  properties: {
    storyId: { type: "number", description: "Story id (from snapshot_document / get_text_frame_content)" },
    frameId: { type: "number", description: "Alternative: id of any frame in the story" },
    maxPages: { type: "number", description: "Max pages to add (1-20). Default 20" },
    masterName: { type: "string", description: "Master spread for new pages. Default: master of the story's last page" },
    frameGeometry: { type: "string", enum: ["margins", "lastFrame"], description: "New frame = page margin box (default) or the last frame's page-relative bounds (mirrored for the opposite side)" },
    allowCrossSection: { type: "boolean", description: "Allow inserting pages right before the start of another section (pushes the next chapter). Default false" },
    allowRowBreak: {
      type: "boolean",
      description:
        "Opt-in: when a table blocks the flow, relax its row keep options (keepWithNextRow -> false, startRow -> ANYWHERE) and retry once; " +
        "changes are reported in rowBreakChanges and reverted if they do not help. InDesign cannot split a single row across frames. Default false",
    },
    document_id: { type: "string", description: "Optional target document name" },
  },
};

export function registerSafeContentTools(bridge: InDesignBridge) {
  return {
    replace_paragraphs: {
      description:
        "THE primitive for content replacement that must preserve exact formatting. Edits paragraphs of ONE story by story-relative " +
        "paragraphIndex (from snapshot_document: storyParagraphIndex; always the index BEFORE this call). Edit kinds: " +
        "(1) replace: `text` (replaces the paragraph text after any leading anchored icon/tab prefix, never the trailing return; optional " +
        "styleId/styleName restyles the paragraph and clears its overrides) or `label`/`value` (replaces the bold 'Label' before ':' and the roman " +
        "value after it separately, each keeping its own formatting; label/value detection uses the EFFECTIVE formatting incl. GREP/nested styles, " +
        "applied[] reports labelFontStyle/valueFontStyle and the raw text-style-range values). (2) {delete:true, expectText?}: removes the whole " +
        "paragraph incl. its return; refused when it holds an anchored object or does not start with expectText. A paragraph holding an inline TABLE " +
        "is deleted only with {delete:true, allowTable:true} plus expectText (paragraph text or first-cell text) or expectTableRows/expectTableColumns; " +
        "the table dimensions (rows, columns, cellCount, firstCellExcerpt) are reported and it is refused when a cell holds an anchored object. If the " +
        "deleted paragraph restarted a numbered list, the restart (numberingContinue/numberingStartAt) moves to the following numbered paragraph " +
        "(applied[].numberingRestartMovedTo). (3) {insertAfter:true, text | label/value, styleId?|styleName?}: inserts a new paragraph after the given " +
        "one in the anchor's style (or styleId); label/value copies the anchor's Label: value formatting. After an insert (or a replace that changes " +
        "the style) the FOLLOWING paragraph's local spaceBefore override is reported as a warning; resetNextSpacing:true on that edit sets it to the " +
        "style value (applied[].spacingReset). Text containing ':' written into a paragraph whose GREP/nested style keys on ':' (e.g. '.+(?<=:)' -> Bold) " +
        "where the template text has no ':' is a mismatch unless acceptGrepEffects:true (per edit or for the call); so is a resulting paragraph (text split on \\r) " +
        "with 2+ ':' under a GREP that runs to the LAST colon such as '.+(?<=:)' (part of the value would be bold; mismatch.multiColon names it; '(?=:).+' starts at the " +
        "first colon and is not flagged for this). Paragraph-level overrides (list " +
        "restarts, indents, space, keeps) are snapshotted and restored; new paragraphs from \\r continue the list; list numbers of following numbered " +
        "paragraphs are compared before/after (warning + numberingChanges when they change beyond the inserted/deleted count). Applied last-to-first " +
        "in one undo step ('replace_paragraphs'). A lone \\n becomes a forced line break; \\r starts a new paragraph. Edits that do not fit are NOT " +
        "changed and are listed in mismatches[] (all edits of that paragraph are skipped, also when edits for one paragraphIndex conflict, e.g. replace " +
        "+ delete). Fails and undoes itself if the anchored object count or a paragraph style changes. " +
        "A write that hides text (the story newly overflows, or an edited paragraph that was composed is overset now — e.g. a title in a single " +
        "unthreaded frame) is undone by default: success with applied:false, rolledBack:true, revertedEdits and a mismatch {kind:'overset', frameId, " +
        "singleUnthreadedFrame, paragraphs}; allowOverset:true keeps it (warning). warnings[] reports overset paragraphs and icon lines that start " +
        "wrapping; applied[] has lineCountBefore/After. Use dryRun:true to preview.",
      inputSchema: {
        type: "object" as const,
        properties: {
          storyId: { type: "number", description: "Story id" },
          frameId: { type: "number", description: "Alternative: id of any frame in the story" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                paragraphIndex: { type: "number", description: "Story-relative paragraph index (0-based), as it is before this call" },
                text: { type: "string" },
                label: { type: "string", description: "New label text (without the colon)" },
                value: { type: "string", description: "New value text after 'Label:'" },
                styleId: { type: "number", description: "Paragraph style for a text replace or an insert (restyle; clears paragraph overrides)" },
                styleName: { type: "string", description: "Alternative to styleId: style name or 'Group/Name' path" },
                delete: { type: "boolean", description: "Delete this paragraph (including its return)" },
                expectText: { type: "string", description: "delete only: the paragraph (or, with allowTable, the first table cell) must start with this text" },
                allowTable: { type: "boolean", description: "delete only: allow deleting a paragraph that holds an inline table (needs expectText or expectTableRows/expectTableColumns)" },
                expectTableRows: { type: "number", description: "delete + allowTable: the table must have this many rows" },
                expectTableColumns: { type: "number", description: "delete + allowTable: the table must have this many columns" },
                insertAfter: { type: "boolean", description: "Insert a new paragraph after this one (text or label/value)" },
                resetNextSpacing: { type: "boolean", description: "insertAfter / restyling replace: set the following paragraph's spaceBefore to its style value (reported in spacingReset). Default false: only a warning" },
                acceptGrepEffects: { type: "boolean", description: "Write text containing ':' even though a ':'-keyed GREP/nested style will re-format it (warning instead of mismatch)" },
                expectStyleId: { type: "number", description: "Only apply if the paragraph (anchor, for inserts) has this paragraph style id" },
              },
              required: ["paragraphIndex"],
            },
          },
          acceptGrepEffects: { type: "boolean", description: "Same as the per-edit flag, for every edit of the call. Default false" },
          allowOverset: { type: "boolean", description: "Keep a write that pushes text into overset (warning). Default false: such a write is undone and reported as a mismatch. Pass true when the overflow is intended and you cascade it next with continue_story (story overflowing past its last threaded frame)" },
          autoFlow: { type: "boolean", description: "Automatically calls continue_story after the write if the story overflows, adding pages as needed. If continue_story fails (e.g. a table blocks the flow), the entire write is rolled back. Default false — set true to enable automatic overflow handling" },
          serviceIndex: { type: "number", description: "0-based service index within the chapter story (Part Heading boundaries). When set, paragraphIndex in every edit is service-relative (0 = first paragraph of that service). Use list_chapter_services to discover the service boundaries." },
          partHeadingStyleId: { type: "number", description: "Style id of the Part Heading paragraph style used to detect service boundaries (default: auto-detect by style name 'Part Heading')" },
          partHeadingStyleName: { type: "string", description: "Style name or 'Group/Name' path for Part Heading detection (alternative to partHeadingStyleId)" },
          keepLeadingAnchors: { type: "boolean", description: "Keep leading U+FFFC/tab prefix. Default true" },
          dryRun: { type: "boolean", description: "Validate and report without changing anything. Default false" },
          document_id: { type: "string", description: "Optional target document name" },
        },
        required: ["edits"],
      },
      handler: async (args: Record<string, unknown>) => replaceParagraphs(bridge, args),
    },

    replace_contact_block: {
      description:
        "Replace a contact-details block line by line while keeping each line next to its icon. Works for a group (one text frame + icon " +
        "shapes, matched by vertical order) or a frame whose lines start with an inline anchored icon (+tab). In inline mode the story is split " +
        "into blocks of consecutive icon lines; the block is chosen by blockIndex, by firstParagraphIndex/storyParagraphIndex (block containing " +
        "that paragraph) or as the single block starting inside frameId's text. When that is ambiguous nothing changes and a mismatch with " +
        "availableBlocks is returned. lines: [{type:'address'|'phone'|'email'|'web'|'fax', text}]. If the line count or type order differs from the " +
        "template (or a type such as fax has no icon), nothing is changed and a mismatch {templateTypes, sourceTypes} is returned — record it, " +
        "do not force the text in. Explicit opt-ins: typeAliases {fax:'phone'} maps a source type onto a template icon (result.aliasesUsed); " +
        "extraIcons [{type, iconFrom:{storyId, characterIndex} | {pageItemId}}] ADDS a line for a type the block lacks (inline-anchor blocks only): " +
        "a new contact line after the preceding line, with the icon duplicated from another block, a tab and the text; the template paragraph " +
        "overrides are copied, the anchor count must grow by exactly the added icons and the icon size must equal the source (else undone). " +
        "Text with ':' in a line whose GREP/nested style keys on ':' (bold up to the colon) where the template line has none is a mismatch unless " +
        "acceptGrepEffects:true; so is a line with 2+ ':' under a greedy GREP such as '.+(?<=:)' (bold up to the LAST colon: the mismatch names the " +
        "line and the value part that would be bold). wrapPolicy for a previously single-line line that now wraps: 'mismatch' (default: the write is undone and a " +
        "mismatch {line, text, frameWidth, suggestion} returned), 'warn' (keep, warning), 'hangingIndent' (indent that paragraph so wrapped lines " +
        "align with the text; result.hangingIndentApplied, then re-measured). Under every wrapPolicy, a line that was composed before the write and is " +
        "(partly) overset after it — or a story that newly overflows — undoes the write: applied:false, rolledBack:true, mismatches " +
        "[{line, reason:'pushed into overset', frameId}] (result.oversetLines); allowOverset:true keeps it with warnings. Returns " +
        "overflows, icon/line vertical deltas, lineCount per line and warnings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          groupId: { type: "number", description: "Group containing the contact text frame and icons" },
          frameId: { type: "number", description: "Contact text frame (inline-anchor structure, or a frame inside the group)" },
          blockIndex: { type: "number", description: "Inline mode: index of the contact block in the story (see availableBlocks)" },
          firstParagraphIndex: { type: "number", description: "Inline mode: story paragraph index inside the block to replace" },
          storyParagraphIndex: { type: "number", description: "Alias of firstParagraphIndex" },
          lines: {
            type: "array",
            items: { type: "object", properties: { type: { type: "string", enum: ["address", "phone", "email", "web", "fax"] }, text: { type: "string" } }, required: ["type", "text"] },
          },
          templateTypes: { type: "array", items: { type: "string" }, description: "Override the detected template line types (top to bottom)" },
          typeAliases: { type: "object", description: "Explicit opt-in mapping of a source type onto a template icon type, e.g. {fax:'phone'} (reported in aliasesUsed)" },
          extraIcons: {
            type: "array",
            description: "Add lines for types the block lacks, with an icon duplicated from another block (inline-anchor blocks only)",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["address", "phone", "email", "web", "fax"] },
                iconFrom: {
                  type: "object",
                  description: "{storyId, characterIndex} of the U+FFFC icon character, or {pageItemId} of the icon item",
                  properties: { storyId: { type: "number" }, characterIndex: { type: "number" }, pageItemId: { type: "number" } },
                },
              },
              required: ["type", "iconFrom"],
            },
          },
          wrapPolicy: { type: "string", enum: ["mismatch", "warn", "hangingIndent"], description: "What to do when a previously single-line line wraps. Default 'mismatch' (undo + mismatch)" },
          acceptGrepEffects: { type: "boolean", description: "Write lines containing ':' even though a ':'-keyed GREP/nested style will bold them (warning instead of mismatch)" },
          allowOverset: { type: "boolean", description: "Keep a write that pushes contact lines (or following text) into overset (warning). Default false: undo + 'pushed into overset' mismatch" },
          autoFlow: { type: "boolean", description: "Automatically calls continue_story after the write if the story overflows, adding pages as needed. If continue_story fails (e.g. a table blocks the flow), the entire write is rolled back. Default false — set true to enable automatic overflow handling" },
          dryRun: { type: "boolean" },
          document_id: { type: "string", description: "Optional target document name" },
        },
        required: ["lines"],
      },
      handler: async (args: Record<string, unknown>) => replaceContactBlock(bridge, args),
    },

    verify_page_invariants: {
      description:
        "Read-only check of the content rules on specific pages: text frames/groups outside the margin box, overlapping text frames, " +
        "placeholder text (Lorem/ipsum), overset stories (incl. grouped frames), master-page text frames shown on the page (overset or " +
        "placeholder running heads/folios, under masterIssues), anchored-object counts, paragraph style sequence and the vertical gaps between " +
        "stacked items. Overlaps with EMPTY text frames (background/placeholder frames) are listed under emptyFrameOverlaps and do not make ok " +
        "false. Pass the data of a previous call as `baseline` (e.g. taken before an edit) to diff page count, anchor counts, style sequence " +
        "and gaps (gap delta > gapTolerance, default 6pt, is flagged); judge an edit primarily by baselineDiff.problems, since a pristine " +
        "template page may already have findings. checkThreading:true additionally flags non-anchored content frames that are standalone " +
        "(single-frame story, not threaded) — chapter content frames must always be linked/threaded; reported under unthreadedFrames. " +
        "Run it after EVERY page you change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndexes: { type: "array", items: { type: "number" }, description: "0-based document page offsets (max 16)" },
          baseline: { type: "object", description: "data object from a previous verify_page_invariants call" },
          excludeNamePrefixes: { type: "array", items: { type: "string" }, description: "Item name prefixes to ignore (case-insensitive). Default ['bleed']" },
          marginTolerance: { type: "number", description: "Points of tolerance for margin checks. Default 0.5" },
          gapTolerance: { type: "number", description: "Gap delta (pt) flagged against the baseline. Default 6" },
          checkThreading: { type: "boolean", description: "When true, flags non-anchored content text frames that belong to a single-frame (unthreaded) story — every chapter content frame must be threaded. Reported under unthreadedFrames in each page report. Default false" },
          document_id: { type: "string", description: "Optional target document name" },
        },
        required: ["pageIndexes"],
      },
      handler: async (args: Record<string, unknown>) => verifyPageInvariants(bridge, args),
    },

    list_chapter_services: {
      description:
        "Read-only: scan a chapter story for Part Heading paragraphs and return one entry per service block — {serviceIndex, partHeadingText, " +
        "providerName (the paragraph immediately after the Part Heading), startParagraphIndex, endParagraphIndex}. Use this before replace_paragraphs " +
        "with serviceIndex to know which service starts where. Detects Part Heading paragraphs automatically by style name matching 'Part Heading'; " +
        "pass partHeadingStyleId or partHeadingStyleName to override. Returns storyId, totalParagraphs, serviceCount and the services array.",
      inputSchema: {
        type: "object" as const,
        properties: {
          storyId: { type: "number", description: "Story id" },
          frameId: { type: "number", description: "Alternative: id of any frame in the story" },
          partHeadingStyleId: { type: "number", description: "Override: id of the Part Heading paragraph style" },
          partHeadingStyleName: { type: "string", description: "Override: style name or 'Group/Name' path for the Part Heading style" },
          document_id: { type: "string", description: "Optional target document name" },
        },
        required: [],
      },
      handler: async (args: Record<string, unknown>) => listChapterServices(bridge, args),
    },

    continue_story: {
      description:
        "Fix overset text the safe way: while the story overflows, insert a page right after the page of the story's last frame (same master), " +
        "add a frame at the margin box and thread it. Never moves or resizes existing items and never changes font sizes. Max 20 pages, 90 s guard. " +
        "Refuses to insert right before another section's start unless allowCrossSection:true. When the overset text cannot flow, it fails with " +
        "data.blocker (first overset paragraph and text, keep options, break character, oversized anchored object, blocking table rows) instead of " +
        "guessing; allowRowBreak:true opts in to relaxing that table's row keep options once. Returns the pages added (name, offset, side) and a " +
        "facing-parity warning when an odd number of pages was inserted. One undo step ('continue_story').",
      inputSchema: CONTINUE_STORY_SCHEMA,
      handler: async (args: Record<string, unknown>) => continueStory(bridge, args),
    },
  };
}

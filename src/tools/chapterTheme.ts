/**
 * Chapter theming (batch C): duplicate a master spread for a new chapter,
 * recolour one swatch to another inside an explicit scope, and a one-undo-step
 * wrapper that does both plus style duplication.
 *
 * Registered by spreading registerChapterThemeTools() into the object returned
 * by registerStyleTools (src/tools/style.ts), so src/index.ts is unchanged.
 *
 * ExtendScript helpers are prefixed __ct_ and are shipped through
 * runTp(..., { prelude: CT_PRELUDE }). They rely on the __tp_ helpers of
 * textPipelineShared.ts (TP_HELPERS is always emitted before the prelude).
 */
import type { InDesignBridge } from "../bridge/index.js";
import { guarded, jsJson, jsStr, jsx, runTp } from "./textPipelineShared.js";

export const CT_PRELUDE = jsx`
function __ct_err(e) { return String(e && e.message ? e.message : e); }
function __ct_trim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }

// Document the swatch helpers resolve typed objects against (set by __ct_swatch / __ct_swap).
var __CT_DOC = null;
// id -> { base: baseColor id, tv: tintValue } | null  (null = not a tint). Reset per script run.
var __CT_TINFO = {};
function __ct_doc() { if (__CT_DOC) return __CT_DOC; try { __CT_DOC = __resolveDocument(); } catch (e) {} return __CT_DOC; }
// doc.swatches[i] and colour-valued properties (fillColor, paragraphShadingColor, ...)
// can come back as the generic 'Swatch' class: constructor.name is 'Swatch', a Tint
// does not expose baseColor and doc.tints.add() rejects it. Resolve the concrete
// Color / Tint / Gradient / MixedInk by id (getElements first, then the typed
// collections; tints before colors because a Tint is also a colour).
function __ct_typed(c) {
  if (!c || typeof c !== 'object') return c;
  var t = __tp_type(c);
  if (t === 'Color' || t === 'Tint' || t === 'Gradient' || t === 'MixedInk' || t === 'MixedInkGroup') return c;
  var g = __tp_concrete(c), gt = __tp_type(g);
  if (gt === 'Color' || gt === 'Tint' || gt === 'Gradient' || gt === 'MixedInk' || gt === 'MixedInkGroup') return g;
  var doc = __ct_doc(), id = null;
  if (!doc) return c;
  try { id = c.id; } catch (e) { return c; }
  if (id === null || id === undefined) return c;
  var cols = ['tints', 'colors', 'gradients', 'mixedInks'];
  for (var k = 0; k < cols.length; k++) {
    try {
      var o = doc[cols[k]].itemByID(Number(id));
      if (!o || !o.isValid) continue;
      o = __tp_concrete(o);
      if (cols[k] === 'tints') { var b = o.baseColor; if (!b || typeof b !== 'object') continue; }
      return o;
    } catch (e2) {}
  }
  return c;
}
// Tint info of a colour value (cached by id): { base, tv } or null when it is not a tint.
function __ct_tintInfo(c, id) {
  var key = String(id);
  if (__CT_TINFO.hasOwnProperty(key)) return __CT_TINFO[key];
  var info = null, o = __ct_typed(c), b = null, tv = null;
  try { b = o.baseColor; tv = Number(o.tintValue); } catch (e) { b = null; }
  if (b && typeof b === 'object') { try { if (b.id !== undefined && b.id !== null && Number(b.id) !== Number(id)) info = { base: b.id, tv: isNaN(tv) ? null : tv }; } catch (e2) {} }
  __CT_TINFO[key] = info;
  return info;
}
// Swatch by exact name ("Black", "[Black]", "None", "[None]" accepted) or numeric id,
// returned as its concrete class (Color, Tint, ...; see __ct_typed).
function __ct_swatch(doc, ref, what) {
  if (doc) __CT_DOC = doc;
  if (ref === null || ref === undefined || ref === '') throw new Error((what || 'swatch') + ' is required');
  var s = String(ref);
  var m = /^\[(.+)\]$/.exec(s);
  if (m) s = m[1];
  // qa-r3-02: doc.swatches[i] is the generic 'Swatch' class (no Color type, tints.add
  // rejects it as a base). Resolve a named swatch through the typed collections
  // first (itemByName + getElements()[0]): tints before colours (a Tint is also a colour).
  var cols = ['tints', 'colors', 'gradients', 'mixedInks'], k;
  for (k = 0; k < cols.length; k++) {
    try {
      var o = doc[cols[k]].itemByName(s);
      if (!o || !o.isValid) continue;
      o = __tp_concrete(o);
      if (cols[k] === 'tints') { var tb = null; try { tb = o.baseColor; } catch (eB) {} if (!tb || typeof tb !== 'object') continue; }
      var ot = __tp_type(o);
      if (ot === 'Color' || ot === 'Tint' || ot === 'Gradient' || ot === 'MixedInk') return o;
    } catch (eT) {}
  }
  if (/^\d+$/.test(s)) {
    for (k = 0; k < cols.length; k++) {
      try {
        var oi = doc[cols[k]].itemByID(Number(s));
        if (!oi || !oi.isValid) continue;
        oi = __tp_concrete(oi);
        if (cols[k] === 'tints') { var tb2 = null; try { tb2 = oi.baseColor; } catch (eB2) {} if (!tb2 || typeof tb2 !== 'object') continue; }
        var oit = __tp_type(oi);
        if (oit === 'Color' || oit === 'Tint' || oit === 'Gradient' || oit === 'MixedInk') return oi;
      } catch (eI) {}
    }
  }
  var sw = doc.swatches, i, hit = null;
  for (i = 0; i < sw.length && !hit; i++) { if (sw[i].name === s) hit = sw[i]; }
  if (!hit && /^\d+$/.test(s)) { for (i = 0; i < sw.length && !hit; i++) { if (sw[i].id === Number(s)) hit = sw[i]; } }
  if (!hit) throw new Error((what || 'swatch') + ' not found: ' + ref);
  var typed = __ct_typed(hit);
  if (__tp_type(typed) === 'Swatch') {
    // last resort: the named Color (Paper/Black/Registration/spot/process colours)
    try { var cc = doc.colors.itemByName(String(hit.name)); if (cc && cc.isValid) { cc = __tp_concrete(cc); if (cc.id === hit.id) typed = cc; } } catch (e) {}
  }
  return typed;
}
function __ct_same(c, sw) { try { return !!c && typeof c === 'object' && c.id === sw.id; } catch (e) { return false; } }
function __ct_swName(c) { try { return c && c.name !== undefined ? String(c.name) : (c === null || c === undefined ? null : String(c)); } catch (e) { return null; } }

// ── style groups ────────────────────────────────────────────────────────────
function __ct_groupsProp(kind) { if (kind === 'paragraph') return 'paragraphStyleGroups'; if (kind === 'character') return 'characterStyleGroups'; if (kind === 'object') return 'objectStyleGroups'; throw new Error('unknown style kind: ' + kind); }
function __ct_stylesProp(kind) { if (kind === 'paragraph') return 'paragraphStyles'; if (kind === 'character') return 'characterStyles'; if (kind === 'object') return 'objectStyles'; throw new Error('unknown style kind: ' + kind); }
function __ct_splitPath(p) {
  var parts = String(p === null || p === undefined ? '' : p).split('/'), out = [];
  for (var i = 0; i < parts.length; i++) { var t = __ct_trim(parts[i]); if (t !== '') out.push(t); }
  return out;
}
function __ct_childGroup(parent, kind, name) {
  var g = parent[__ct_groupsProp(kind)];
  for (var i = 0; i < g.length; i++) { if (g[i].name === name) return g[i]; }
  return null;
}
// Walks (and with create:true builds) a nested style-group path.
// Returns { container: Document|StyleGroup|null, missing: [paths not existing yet], created: [...] }.
function __ct_styleGroup(doc, kind, path, create) {
  var parts = __ct_splitPath(path), cur = doc, missing = [], created = [];
  for (var i = 0; i < parts.length; i++) {
    var g = cur ? __ct_childGroup(cur, kind, parts[i]) : null;
    if (!g) {
      missing.push(parts.slice(0, i + 1).join('/'));
      if (create && cur) { g = cur[__ct_groupsProp(kind)].add({ name: parts[i] }); created.push(parts.slice(0, i + 1).join('/')); }
    }
    cur = g;
  }
  return { container: cur, missing: create ? [] : missing, created: created };
}
function __ct_localStyle(container, kind, name) {
  if (!container) return null;
  var ss = container[__ct_stylesProp(kind)];
  for (var i = 0; i < ss.length; i++) { if (ss[i].name === name) return ss[i]; }
  return null;
}
function __ct_containerPath(container) {
  try { if (/StyleGroup$/.test(__tp_type(container))) return __tp_stylePath(container); } catch (e) {}
  return '';
}

// Duplicate a style into groupPath (or next to the source when groupPath is empty)
// under newName. Throws on a name clash in the target group BEFORE mutating.
function __ct_dupStyle(doc, kind, src, newName, groupPath, dryRun) {
  if (!newName) throw new Error('newName is required to duplicate ' + kind + ' style ' + __tp_stylePath(src));
  var useGroup = __ct_splitPath(groupPath).length > 0;
  var g = useGroup ? __ct_styleGroup(doc, kind, groupPath, false) : null;
  var container = useGroup ? g.container : src.parent;
  var clash = __ct_localStyle(container, kind, newName);
  if (clash) throw new Error(kind + ' style already exists: ' + __tp_stylePath(clash) + ' (id ' + clash.id + ')');
  var targetPath = (useGroup ? __ct_splitPath(groupPath).join('/') : __ct_containerPath(src.parent));
  var rep = { kind: kind, source: __tp_stylePath(src), sourceId: src.id, path: (targetPath ? targetPath + '/' : '') + newName };
  if (dryRun) { rep.groupsToCreate = g ? g.missing : []; return { style: null, report: rep }; }
  if (useGroup) { var built = __ct_styleGroup(doc, kind, groupPath, true); container = built.container; rep.groupsCreated = built.created; }
  var d = src.duplicate();
  var dId = d.id;
  if (useGroup) {
    var mv = null;
    try { mv = d.move(LocationOptions.AT_END, container); } catch (eM) { throw new Error('could not move duplicate of ' + __tp_stylePath(src) + ' into ' + groupPath + ': ' + __ct_err(eM)); }
    // the reference returned by move() (or the old one) can be stale: re-resolve by id (r4-B1)
    try { if (mv && mv.isValid && mv.id !== undefined) dId = mv.id; } catch (eMv) {}
  }
  var dRe = __ct_styleById(doc, kind, dId);
  if (dRe) d = dRe;
  d.name = newName;
  dRe = __ct_styleById(doc, kind, d.id);
  if (dRe) d = dRe;
  if (kind === 'paragraph') {
    try { if (src.nextStyle && src.nextStyle.id === src.id) { d.nextStyle = d; rep.nextStyle = 'self'; } else rep.nextStyle = __tp_stylePath(d.nextStyle); } catch (e) {}
  }
  rep.id = d.id; rep.path = __tp_stylePath(d);
  return { style: d, report: rep };
}

// ── master spreads ──────────────────────────────────────────────────────────
function __ct_masterList(doc) { var out = []; for (var i = 0; i < doc.masterSpreads.length; i++) out.push(doc.masterSpreads[i].name + ' (id ' + doc.masterSpreads[i].id + ')'); return out.join(', '); }
// By exact full name ("C-Chapter 3"), id, prefix ("C") or unique base name.
function __ct_findMaster(doc, ref) {
  var ms = doc.masterSpreads, s = String(ref), i, hits = [];
  for (i = 0; i < ms.length; i++) if (ms[i].name === s) return ms[i];
  if (/^\d+$/.test(s)) for (i = 0; i < ms.length; i++) if (ms[i].id === Number(s)) return ms[i];
  for (i = 0; i < ms.length; i++) if (ms[i].namePrefix === s) hits.push(ms[i]);
  if (hits.length === 0) for (i = 0; i < ms.length; i++) if (ms[i].baseName === s) hits.push(ms[i]);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error("master '" + s + "' is ambiguous; use the full name or id. Masters: " + __ct_masterList(doc));
  throw new Error("master spread not found: '" + s + "'. Masters: " + __ct_masterList(doc));
}
function __ct_spreadStories(spread) {
  var seen = {}, out = [], items = spread.allPageItems;
  for (var i = 0; i < items.length; i++) {
    if (__tp_type(items[i]) !== 'TextFrame') continue;
    var st = null;
    try { st = items[i].parentStory; } catch (e) { continue; }
    if (!st || seen[st.id]) continue;
    seen[st.id] = true; out.push(st);
  }
  return out;
}
// Literal (non-GREP) replace inside one story, last match first so indexes stay
// valid. Each match is verified against the DOM text before it is replaced
// (story.contents and character indexes can disagree around text variables).
function __ct_storyOverset(story) { try { return story.overflows === true; } catch (e) { return false; } }
function __ct_lastFrame(story) { try { var tc = story.textContainers; return tc.length ? tc[tc.length - 1] : null; } catch (e) { return null; } }
function __ct_snip(s) { s = __tp_str(s).replace(/[\r\n]+/g, ' / '); return s.length > 120 ? s.substring(0, 120) + '...' : s; }
// Character formatting of story chars a..b, captured so a rolled-back replacement
// gets its original (possibly mixed, e.g. bold label + roman) formatting back.
var __CT_FMT_PROPS = ['appliedCharacterStyle', 'appliedFont', 'fontStyle', 'pointSize', 'fillColor', 'fillTint', 'strokeColor', 'strokeWeight', 'tracking', 'capitalization',
  'position', 'underline', 'strikeThru', 'horizontalScale', 'verticalScale', 'baselineShift', 'leading', 'kerningMethod'];
function __ct_captureFmt(story, a, b) {
  var out = {}, n = b - a + 1;
  if (n <= 0) return out;
  for (var i = 0; i < __CT_FMT_PROPS.length; i++) {
    var p = __CT_FMT_PROPS[i];
    try { var v = __tp_arr(story.characters.itemByRange(a, b).characters.everyItem()[p]); if (v.length === n) out[p] = v; } catch (e) {}
  }
  return out;
}
function __ct_restoreFmt(story, a, fmt) {
  for (var i = 0; i < __CT_FMT_PROPS.length; i++) {
    var p = __CT_FMT_PROPS[i];
    if (!fmt.hasOwnProperty(p)) continue;
    for (var k = 0; k < fmt[p].length; k++) { try { story.characters[a + k][p] = fmt[p][k]; } catch (e) {} }
  }
}
// ctx (real runs only): { policy: 'rollback'|'keep', mismatches: [], warnings: [] }.
// A replacement that pushes a story that fitted into overset is a mismatch: by
// default it is reverted (text + character formatting); with policy 'keep' it
// stays and is reported.
function __ct_replaceInStory(story, find, repl, dryRun, warnings, ctx) {
  var txt = __tp_str(story.contents), pos = [], p = 0, n = 0;
  while ((p = txt.indexOf(find, p)) >= 0) { pos.push(p); p += find.length; }
  for (var k = pos.length - 1; k >= 0; k--) {
    var rng = story.characters.itemByRange(pos[k], pos[k] + find.length - 1);
    var got = '';
    try { got = __tp_str(rng.contents); } catch (e) {}
    if (got !== find) { warnings.push("story " + story.id + ": match of '" + find + "' at " + pos[k] + ' did not verify (got ' + got.substring(0, 40) + '); left unchanged'); continue; }
    if (dryRun) { n++; continue; }
    var wasOver = __ct_storyOverset(story);
    var fmt = ctx ? __ct_captureFmt(story, pos[k], pos[k] + find.length - 1) : null;
    rng.contents = repl;
    if (ctx && !wasOver && __ct_storyOverset(story)) {
      var fr = __ct_lastFrame(story);
      var mm = { type: 'textReplaceOverset', story: story.id, frameId: fr ? fr.id : null, frameName: fr ? __tp_name(fr) : '', find: find, replace: repl,
        text: __ct_snip(story.contents), action: ctx.policy === 'keep' ? 'kept' : 'rolledBack' };
      if (ctx.policy !== 'keep') {
        try {
          if (repl.length > 0) story.characters.itemByRange(pos[k], pos[k] + repl.length - 1).contents = find;
          else story.insertionPoints[pos[k]].contents = find;
          __ct_restoreFmt(story, pos[k], fmt);
          var back = '';
          try { back = __tp_str(story.characters.itemByRange(pos[k], pos[k] + find.length - 1).contents); } catch (eB) {}
          if (back !== find) { mm.action = 'rollbackFailed'; mm.rollbackText = back.substring(0, 60); }
          mm.oversetAfterRollback = __ct_storyOverset(story);
          mm.text = __ct_snip(story.contents);
        } catch (eR) { mm.action = 'rollbackFailed'; mm.rollbackError = __ct_err(eR); }
      }
      ctx.mismatches.push(mm);
      // built from the FINAL mm.action (after the rollback attempt); inner ternary parenthesised (ExtendScript, round-4 F2 / r4-B2)
      var how = 'ROLLBACK FAILED: check this frame.';
      if (mm.action === 'rolledBack') how = 'the replacement was rolled back. Shorten the replacement text or enlarge the frame.';
      else if (mm.action === 'kept') how = 'kept because textReplaceOverset is "keep": the frame now has hidden text.';
      mm.message = how;
      warnings.push('textReplace mismatch: replacing "' + find + '" with "' + repl + '" pushes ' + (fr ? 'frame ' + fr.id + (mm.frameName ? ' (' + mm.frameName + ')' : '') : 'story ' + story.id) +
        ' into overset (text: "' + mm.text + '"); ' + how);
      if (mm.action === 'rolledBack') continue;
    }
    n++;
  }
  return n;
}
function __ct_dupMaster(doc, srcRef, prefix, baseName, textReplace, dryRun, warnings, oversetPolicy) {
  var src = __ct_findMaster(doc, srcRef);
  var newName = prefix + '-' + baseName, ms = doc.masterSpreads;
  for (var i = 0; i < ms.length; i++) {
    if (ms[i].name === newName) throw new Error('master spread already exists: ' + newName + ' (id ' + ms[i].id + ')');
    if (ms[i].namePrefix === prefix) throw new Error("master prefix '" + prefix + "' is already used by " + ms[i].name + ' (id ' + ms[i].id + '); choose another newNamePrefix');
  }
  var rep = { source: { id: src.id, name: src.name, pages: src.pages.length }, name: newName, replacements: [] };
  var target = src;
  if (!dryRun) {
    target = src.duplicate();
    target.namePrefix = prefix;
    target.baseName = baseName;
    rep.id = target.id; rep.name = target.name; rep.pages = target.pages.length;
    try { rep.basedOnMaster = target.appliedMaster && target.appliedMaster.isValid ? target.appliedMaster.name : null; } catch (e) { rep.basedOnMaster = null; }
  }
  var stories = __ct_spreadStories(target);
  var ctx = dryRun ? null : { policy: (oversetPolicy === 'keep' ? 'keep' : 'rollback'), mismatches: [] };
  var preOver = {}, touched = {};
  if (!dryRun) for (var s0 = 0; s0 < stories.length; s0++) preOver[stories[s0].id] = __ct_storyOverset(stories[s0]);
  for (var t = 0; t < textReplace.length; t++) {
    var cnt = 0, before = ctx ? ctx.mismatches.length : 0;
    for (var s = 0; s < stories.length; s++) {
      var c1 = __ct_replaceInStory(stories[s], textReplace[t].find, textReplace[t].replace, dryRun, warnings, ctx);
      if (c1 > 0) touched[stories[s].id] = stories[s];
      cnt += c1;
    }
    var rr = { find: textReplace[t].find, replace: textReplace[t].replace, count: cnt };
    if (ctx) {
      var rb = 0;
      for (var q = before; q < ctx.mismatches.length; q++) if (ctx.mismatches[q].action === 'rolledBack') rb++;
      if (rb > 0) rr.rolledBack = rb;
    }
    rep.replacements.push(rr);
    if (cnt === 0 && !(rr.rolledBack > 0)) warnings.push("textReplace '" + textReplace[t].find + "' matched nothing on " + (dryRun ? src.name : rep.name));
  }
  if (ctx) {
    // final check of every touched frame (several replacements in one story can add up)
    for (var sid in touched) {
      if (!touched.hasOwnProperty(sid)) continue;
      var st = touched[sid];
      if (!__ct_storyOverset(st)) continue;
      var fr = __ct_lastFrame(st), already = false;
      for (var q2 = 0; q2 < ctx.mismatches.length; q2++) if (ctx.mismatches[q2].story === st.id && ctx.mismatches[q2].action !== 'rolledBack') already = true;
      if (already) continue;
      var mm = { type: 'textReplaceOverset', story: st.id, frameId: fr ? fr.id : null, frameName: fr ? __tp_name(fr) : '', text: __ct_snip(st.contents),
        action: preOver[st.id] ? 'oversetBefore' : 'overset' };
      ctx.mismatches.push(mm);
      warnings.push('textReplace mismatch: ' + (fr ? 'frame ' + fr.id : 'story ' + st.id) + ' on ' + rep.name + ' is overset after textReplace' + (preOver[st.id] ? ' (it was already overset in the source master)' : '') + ' (text: "' + mm.text + '")');
    }
    rep.mismatches = ctx.mismatches;
    rep.textReplaceOverset = ctx.policy;
  } else if (textReplace.length > 0) rep.oversetCheck = 'textReplace overset is checked on the real run (a replacement that pushes a frame into overset is rolled back by default)';
  return { master: dryRun ? null : target, source: src, report: rep };
}

// ── swatch matching (tint-aware, several source swatches) ──────────────────
// Resolve a list of swatch refs (deduplicated by id).
function __ct_swatches(doc, refs, what) {
  var arr = __tp_arr(refs), out = [], seen = {};
  if (arr.length === 0) throw new Error((what || 'swatch') + ' is required');
  for (var i = 0; i < arr.length; i++) {
    var s = __ct_swatch(doc, arr[i], (what || 'swatch') + (arr.length > 1 ? '[' + i + ']' : ''));
    if (seen[s.id]) continue;
    seen[s.id] = true; out.push(s);
  }
  return out;
}
// c matches a source swatch when it IS one of F, or is a Tint whose baseColor is
// one of F. Returns { i: index in F, tint: tintValue|null } or null. Strings
// ("Text Color"), enums and null never match.
function __ct_match(c, F) {
  if (!c || typeof c !== 'object') return null;
  var id = null, i;
  try { id = c.id; } catch (e) { return null; }
  if (id === null || id === undefined) return null;
  for (i = 0; i < F.length; i++) if (F[i].id === id) return { i: i, tint: null };
  // tints may arrive as generic 'Swatch' objects: resolve by id (qa-r3-02)
  var ti = __ct_tintInfo(c, id);
  if (!ti) return null;
  for (i = 0; i < F.length; i++) if (F[i].id === ti.base) return { i: i, tint: ti.tv };
  return null;
}
function __ct_sameMatch(a, b) { return !!a && !!b && a.i === b.i && a.tint === b.tint; }
// true when c is the target swatch or a tint of it
function __ct_isTo(c, to) {
  try {
    if (!c || typeof c !== 'object') return false;
    if (c.id === to.id) return true;
    var ti = __ct_tintInfo(c, c.id);
    return !!ti && ti.base === to.id;
  } catch (e) { return false; }
}
// Replacement for a match: R.to itself, or the tint of R.to with the same
// tintValue (found, or created and recorded in R.tintsCreated).
function __ct_target(m, R, dryRun) {
  var to = R.to;
  if (m.tint === null) return to;
  var key = String(m.tint);
  if (R.tintCache.hasOwnProperty(key)) return R.tintCache[key];
  var ts = R.doc.tints, t = null, i;
  for (i = 0; i < ts.length; i++) {
    try { var tb = ts[i].baseColor; if (tb && tb.id === to.id && Math.abs(Number(ts[i].tintValue) - m.tint) < 0.0001) { t = __tp_concrete(ts[i]); break; } } catch (e) {}
  }
  if (!t) {
    // the base of a new tint must be a Color object (a generic Swatch is rejected by tints.add)
    var base = __ct_typed(to);
    if (__tp_type(base) !== 'Color') { try { var cc = R.doc.colors.itemByName(String(to.name)); if (cc && cc.isValid) { cc = __tp_concrete(cc); if (cc.id === to.id) base = cc; } } catch (eC) {} }
    if (__tp_type(base) !== 'Color') throw new Error('cannot make a ' + m.tint + '% tint of ' + to.name + ' (toSwatch is a ' + __tp_type(base) + ', not a colour)');
    if (dryRun) { R.tintsToCreate.push(to.name + ' ' + m.tint + '%'); R.tintCache[key] = to; return to; }
    var err1 = null;
    try { t = R.doc.tints.add(base, { tintValue: m.tint }); }
    catch (e1) { err1 = e1; t = null; }
    if (!t || !__tp_valid(t)) {
      try { t = R.doc.tints.add({ baseColor: base, tintValue: m.tint }); }
      catch (e2) { throw new Error('could not create a ' + m.tint + '% tint of ' + to.name + ': ' + __ct_err(err1 || e2) + ' / ' + __ct_err(e2)); }
    }
    t = __tp_concrete(t);
    try { if (Math.abs(Number(t.tintValue) - m.tint) > 0.0001) t.tintValue = m.tint; } catch (e3) {}
    R.tintsCreated.push({ id: t.id, name: String(t.name), baseColor: String(to.name), tintValue: m.tint });
  }
  R.tintCache[key] = t;
  return t;
}
function __ct_neutral(c) {
  var n = __ct_swName(c);
  if (n === null) return true;
  n = n.replace(/^\[|\]$/g, '');
  return n === 'None' || n === 'Paper' || n === 'Black' || n === 'Registration';
}

// ── swatch swap ─────────────────────────────────────────────────────────────
function __ct_counts() {
  return { pageItemFill: 0, pageItemStroke: 0, pageItemGap: 0, textFill: 0, textStroke: 0, underline: 0, underlineGap: 0, strikeThrough: 0,
    paragraphShading: 0, paragraphBorder: 0, paragraphBorderGap: 0, ruleAbove: 0, ruleBelow: 0, ruleGap: 0, cellFill: 0, cellStroke: 0,
    paragraphStyleProps: 0, characterStyleProps: 0, objectStyleProps: 0 };
}
function __ct_sum(c) { var n = 0; for (var k in c) if (c.hasOwnProperty(k)) n += c[k]; return n; }
// [prop, count key, warn when unreadable]
var __CT_CHAR_ATTRS = [['fillColor', 'textFill', true], ['strokeColor', 'textStroke', true], ['underlineColor', 'underline', true],
  ['underlineGapColor', 'underlineGap', false], ['strikeThroughColor', 'strikeThrough', false], ['strikeThroughGapColor', 'strikeThrough', false]];
var __CT_PARA_ATTRS = [['paragraphShadingColor', 'paragraphShading'], ['paragraphBorderColor', 'paragraphBorder'], ['paragraphBorderGapColor', 'paragraphBorderGap'],
  ['ruleAboveColor', 'ruleAbove'], ['ruleBelowColor', 'ruleBelow'], ['ruleAboveGapColor', 'ruleGap'], ['ruleBelowGapColor', 'ruleGap']];
var __CT_CSTYLE_ATTRS = ['fillColor', 'strokeColor', 'underlineColor', 'underlineGapColor', 'strikeThroughColor', 'strikeThroughGapColor'];
var __CT_PSTYLE_ATTRS = __CT_CSTYLE_ATTRS.concat(['paragraphShadingColor', 'paragraphBorderColor', 'paragraphBorderGapColor', 'ruleAboveColor', 'ruleBelowColor', 'ruleAboveGapColor', 'ruleBelowGapColor']);
var __CT_OSTYLE_ATTRS = ['fillColor', 'strokeColor', 'gapColor'];
var __CT_CELL_STROKES = ['topEdgeStrokeColor', 'bottomEdgeStrokeColor', 'leftEdgeStrokeColor', 'rightEdgeStrokeColor'];
// NOTE: ExtendScript mis-evaluates unparenthesised chained ternaries (a ? x : b ? y : z);
// always parenthesise the inner ternary (round-4 F2).
function __ct_styleAttrs(kind) { return kind === 'paragraph' ? __CT_PSTYLE_ATTRS : (kind === 'character' ? __CT_CSTYLE_ATTRS : __CT_OSTYLE_ATTRS); }
// Reads one property of a style: { ok: true, v } or { ok: false, err }.
function __ct_read(st, prop) { try { return { ok: true, v: st[prop] }; } catch (e) { return { ok: false, err: __ct_err(e) }; } }
// A style re-resolved by id as a concrete object (a reference kept across
// duplicate()/move() can go stale: paragraph-only colour attributes then throw).
function __ct_styleById(doc, kind, id) {
  var all = null, i;
  try { all = kind === 'paragraph' ? doc.allParagraphStyles : (kind === 'character' ? doc.allCharacterStyles : doc.allObjectStyles); } catch (e) { return null; }
  for (i = 0; i < all.length; i++) { try { if (all[i].id === Number(id)) return __tp_concrete(all[i]); } catch (e2) {} }
  try {
    var col = doc[__ct_stylesProp(kind)].itemByID(Number(id));
    if (col && col.isValid) return __tp_concrete(col);
  } catch (e3) {}
  return null;
}

function __ct_arrProp(ev, prop) { try { return __tp_arr(ev[prop]); } catch (e) { return null; } }
function __ct_isNoneStyle(cs) { try { return !cs || cs.name === '[None]' || cs.name === ''; } catch (e) { return true; } }

function __ct_hit(R, key, m) { R.counts[key]++; R.per[m.i]++; if (m.tint !== null) R.tintHits++; }
// Colour that comes from a style. A style that is itself in this call's scope is
// recoloured at the end of the call (viaScopedStyle); any other style keeps the
// source colour (styleDerived, named in derivedFromStyles).
function __ct_derived(R, key, st, kind, how) {
  var id = null;
  try { id = st.id; } catch (e) {}
  if (id !== null && id !== undefined && R.scopeStyleIds[kind + ':' + id]) { R.viaScopedStyle[key]++; return; }
  R.styleDerived[key]++;
  var p = kind + ' style ';
  try { p += __tp_stylePath(st); } catch (e2) { p += '?'; }
  if (how) p += ' (' + how + ')';
  R.derivedFrom[p] = (R.derivedFrom[p] || 0) + 1;
}

// Character styles with any colour attribute equal to (a tint of) a source swatch:
// { any, ids: { styleId: { prop: true } } }. Used to detect GREP/nested-derived colour.
function __ct_fromCharStyles(doc, F) {
  var out = { any: false, ids: {} }, all = doc.allCharacterStyles;
  for (var i = 0; i < all.length; i++) {
    for (var a = 0; a < __CT_CHAR_ATTRS.length; a++) {
      var v = null;
      try { v = all[i][__CT_CHAR_ATTRS[a][0]]; } catch (e) { continue; }
      if (!__ct_match(v, F)) continue;
      if (!out.ids[all[i].id]) out.ids[all[i].id] = {};
      out.ids[all[i].id][__CT_CHAR_ATTRS[a][0]] = true;
      out.any = true;
    }
  }
  return out;
}
// Nested / GREP / line style entries of a paragraph or paragraph style.
function __ct_nestedRefs(p) {
  var out = [], cols = ['nestedGrepStyles', 'nestedStyles', 'nestedLineStyles'];
  for (var c = 0; c < cols.length; c++) {
    var col = null, n = 0;
    try { col = p[cols[c]]; n = col.length; } catch (e) { continue; }
    for (var k = 0; k < n; k++) {
      var en = null, cs = null;
      try { en = col[k]; cs = en.appliedCharacterStyle; } catch (e2) { continue; }
      out.push({ kind: cols[c], index: k, entry: en, cs: cs });
    }
  }
  return out;
}
// Paragraph map of a text object (absolute character indexes, clamped to it):
// { any, list: [{ s, e, grep, cs: [char styles applied by nested/GREP/line styles], styleName }] }
function __ct_grepParas(textObj, base, endEx, R) {
  var out = { any: false, list: [] }, paras = null, n = 0;
  try { paras = textObj.paragraphs; n = paras.length; } catch (e) { return out; }
  if (n === 0) return out;
  var pev = paras.everyItem();
  var pidx = __ct_arrProp(pev, 'index'), pst = __ct_arrProp(pev, 'appliedParagraphStyle');
  if (!pidx || pidx.length !== n) return out;
  for (var j = 0; j < n; j++) {
    var ps = Math.max(Number(pidx[j]), base), pe = (j + 1 < n ? Number(pidx[j + 1]) : endEx) - 1;
    if (pe > endEx - 1) pe = endEx - 1;
    var P = { s: ps, e: pe, grep: false, cs: [], styleName: '' };
    if (pe >= ps) {
      var p = paras[j], ng = 0, nn = 0, nl = 0;
      try { ng = p.nestedGrepStyles.length; } catch (e1) {}
      try { nn = p.nestedStyles.length; } catch (e2) {}
      try { nl = p.nestedLineStyles.length; } catch (e3) {}
      if (ng + nn + nl > 0) {
        P.grep = true; out.any = true;
        var sid = '';
        try { sid = String(pst[j].id); P.styleName = __tp_stylePath(pst[j]); } catch (e4) {}
        var key = sid + '|' + ng + '|' + nn + '|' + nl;
        if (!R.nestedCache.hasOwnProperty(key)) {
          var refs = __ct_nestedRefs(p), cs = [];
          for (var r = 0; r < refs.length; r++) if (!__ct_isNoneStyle(refs[r].cs)) cs.push(refs[r].cs);
          R.nestedCache[key] = cs;
        }
        P.cs = R.nestedCache[key];
      }
    }
    out.list.push(P);
  }
  return out;
}
// Split [s,e] into segments: { s, e, p: grep paragraph | null }. Gaps not covered
// by the paragraph map are returned as plain (p:null) segments.
function __ct_segments(g, s, e) {
  var segs = [], cur = s, L = g.list;
  function plain(a, b) {
    var last = segs.length ? segs[segs.length - 1] : null;
    if (last && !last.p && last.e === a - 1) last.e = b; else segs.push({ s: a, e: b, p: null });
  }
  for (var j = 0; j < L.length && cur <= e; j++) {
    var P = L[j];
    if (P.e < cur || P.s > e || P.e < P.s) continue;
    var a = Math.max(P.s, cur), b = Math.min(P.e, e);
    if (a > cur) plain(cur, a - 1);
    if (P.grep) segs.push({ s: a, e: b, p: P }); else plain(a, b);
    cur = b + 1;
  }
  if (cur <= e) plain(cur, e);
  return segs;
}
// First nested/GREP character style of paragraph P whose prop is a source colour.
function __ct_nestedFrom(P, prop, R) {
  if (!R.fromCS.any) return null;
  for (var i = 0; i < P.cs.length; i++) {
    var id = null;
    try { id = P.cs[i].id; } catch (e) { continue; }
    if (R.fromCS.ids[id] && R.fromCS.ids[id][prop]) return P.cs[i];
  }
  return null;
}
// Effective per-character values of prop for chars a..b (relative to textObj).
// Character-level reads include GREP/nested style results, textStyleRanges do not.
function __ct_effective(textObj, a, b, prop) {
  var n = b - a + 1, v = null;
  try { v = __tp_arr(textObj.characters.itemByRange(a, b).characters.everyItem()[prop]); if (v.length === n) return v; } catch (e) {}
  try { v = __tp_arr(textObj.characters.itemByRange(a, b)[prop]); if (v.length === n) return v; } catch (e1) {}
  if (n > 4000) return null;
  try { v = []; for (var k = a; k <= b; k++) v.push(textObj.characters[k][prop]); return v; } catch (e2) {}
  return null;
}
// A run whose colour matches: in localOnly, colour defined by the applied
// character/paragraph style is left alone; otherwise the run is queued.
function __ct_textCandidate(R, spans, s, e, m, mode, prop, key, cs, ps, base) {
  if (mode === 'localOnly') {
    var csVal = null;
    if (!__ct_isNoneStyle(cs)) { try { csVal = cs[prop]; } catch (e1) { csVal = null; } }
    if (csVal && typeof csVal === 'object' && csVal.id !== undefined) {
      if (__ct_match(csVal, R.F)) { __ct_derived(R, key, cs, 'character'); return; }
    } else {
      var pv = null;
      try { pv = ps[prop]; } catch (e2) { pv = null; }
      if (__ct_match(pv, R.F)) { __ct_derived(R, key, ps, 'paragraph'); return; }
    }
  }
  spans.push({ s: s - base, e: e - base, m: m });
}

// Recolour one text object (frame text, story text or cell text).
// Character attributes are read per textStyleRange; inside paragraphs that have
// nested/GREP/line styles the EFFECTIVE per-character value decides: characters
// whose effective colour is not a source colour (e.g. GREP-applied Black value
// text) are never overridden (grepProtected), and colour that only comes from a
// GREP/nested character style is reported as style-derived (a local override
// would not win over the GREP style anyway; recolour/duplicate that char style).
function __ct_swapText(textObj, mode, dryRun, R, label) {
  var base = 0, endEx = 0;
  try { base = textObj.insertionPoints[0].index; endEx = textObj.insertionPoints[-1].index; } catch (e) { return; }
  if (endEx <= base) return;
  var F = R.F, gInfo = null, grepWarned = false;
  var col = textObj.textStyleRanges;
  if (col.length > 0) {
    var ev = col.everyItem();
    var idx = __tp_arr(ev.index), cstyles = __ct_arrProp(ev, 'appliedCharacterStyle'), pstyles = __ct_arrProp(ev, 'appliedParagraphStyle');
    for (var a = 0; a < __CT_CHAR_ATTRS.length; a++) {
      var prop = __CT_CHAR_ATTRS[a][0], key = __CT_CHAR_ATTRS[a][1];
      var vals = __ct_arrProp(ev, prop);
      if (!vals || vals.length !== idx.length) { if (__CT_CHAR_ATTRS[a][2]) R.warnings.push(label + ': cannot read ' + prop); continue; }
      var spans = [];
      for (var i = 0; i < idx.length; i++) {
        var s = Math.max(idx[i], base), e = (i + 1 < idx.length ? idx[i + 1] : endEx) - 1;
        if (e > endEx - 1) e = endEx - 1;
        if (e < s) continue;
        var m = __ct_match(vals[i], F);
        if (!m && !R.fromCS.any) continue;
        if (gInfo === null) gInfo = __ct_grepParas(textObj, base, endEx, R);
        var segs = gInfo.any ? __ct_segments(gInfo, s, e) : [{ s: s, e: e, p: null }];
        var csI = cstyles ? cstyles[i] : null, psI = pstyles ? pstyles[i] : null;
        for (var q = 0; q < segs.length; q++) {
          var sg = segs[q];
          if (!sg.p) { if (m) __ct_textCandidate(R, spans, sg.s, sg.e, m, mode, prop, key, csI, psI, base); continue; }
          var ncs = __ct_nestedFrom(sg.p, prop, R);
          if (!m && !ncs) continue;
          if (!grepWarned) { grepWarned = true; R.grepParagraphs++; }
          var eff = __ct_effective(textObj, sg.s - base, sg.e - base, prop);
          if (!eff) {
            if (m) {
              R.grepProtected += sg.e - sg.s + 1;
              R.warnings.push(label + ': could not read effective ' + prop + ' in GREP/nested paragraph (' + sg.p.styleName + '), chars ' + (sg.s - base) + '-' + (sg.e - base) + ' left unchanged');
            }
            continue;
          }
          var k = 0;
          while (k < eff.length) {
            var em = __ct_match(eff[k], F), k2 = k + 1;
            if (em) { while (k2 < eff.length && __ct_sameMatch(__ct_match(eff[k2], F), em)) k2++; }
            else { while (k2 < eff.length && !__ct_match(eff[k2], F)) k2++; }
            if (!em) { if (m) R.grepProtected += k2 - k; }
            else if (!m || (mode === 'localOnly' && ncs)) { __ct_derived(R, key, ncs || psI, ncs ? 'character' : 'paragraph', 'GREP/nested in ' + sg.p.styleName); R.grepDerived += k2 - k; }
            else __ct_textCandidate(R, spans, sg.s + k, sg.s + k2 - 1, em, mode, prop, key, csI, psI, base);
            k = k2;
          }
        }
      }
      // apply after collecting: recolouring can merge style ranges and shift indexes
      for (var sp = 0; sp < spans.length; sp++) {
        try {
          var tgt = __ct_target(spans[sp].m, R, dryRun);
          if (!dryRun) textObj.characters.itemByRange(spans[sp].s, spans[sp].e)[prop] = tgt;
          __ct_hit(R, key, spans[sp].m);
        } catch (e3) { R.warnings.push(label + ': ' + prop + ' chars ' + spans[sp].s + '-' + spans[sp].e + ': ' + __ct_err(e3)); }
      }
    }
  }
  // paragraph-level attributes
  var paras = textObj.paragraphs;
  if (paras.length > 0) {
    var pev = paras.everyItem();
    var pst = __ct_arrProp(pev, 'appliedParagraphStyle');
    for (var b = 0; b < __CT_PARA_ATTRS.length; b++) {
      var pprop = __CT_PARA_ATTRS[b][0], pkey = __CT_PARA_ATTRS[b][1];
      var pv = __ct_arrProp(pev, pprop);
      if (!pv) continue; // attribute not supported by this InDesign version
      for (var j = 0; j < pv.length; j++) {
        var pm = __ct_match(pv[j], F);
        if (!pm) continue;
        if (mode === 'localOnly' && pst) { var sv = null; try { sv = pst[j][pprop]; } catch (e4) {} if (__ct_match(sv, F)) { __ct_derived(R, pkey, pst[j], 'paragraph'); continue; } }
        try { var ptg = __ct_target(pm, R, dryRun); if (!dryRun) paras[j][pprop] = ptg; __ct_hit(R, pkey, pm); }
        catch (e5) { R.warnings.push(label + ': paragraph ' + j + ' ' + pprop + ': ' + __ct_err(e5)); }
      }
    }
  }
}
function __ct_swapProp(obj, prop, key, dryRun, R, label) {
  var v = null;
  try { v = obj[prop]; } catch (e) { return; }
  var m = __ct_match(v, R.F);
  if (!m) return;
  try { var tgt = __ct_target(m, R, dryRun); if (!dryRun) obj[prop] = tgt; __ct_hit(R, key, m); }
  catch (e2) { R.warnings.push(label + ' ' + prop + ': ' + __ct_err(e2)); }
}
function __ct_swapTables(tables, mode, dryRun, R, label) {
  for (var t = 0; t < tables.length; t++) {
    var cells = tables[t].cells;
    for (var c = 0; c < cells.length; c++) {
      var cell = cells[c], cl = label + ' table ' + t + ' cell ' + c;
      __ct_swapProp(cell, 'fillColor', 'cellFill', dryRun, R, cl);
      for (var k = 0; k < __CT_CELL_STROKES.length; k++) __ct_swapProp(cell, __CT_CELL_STROKES[k], 'cellStroke', dryRun, R, cl);
      try { __ct_swapText(cell.texts[0], mode, dryRun, R, cl); } catch (e2) {}
    }
  }
}
function __ct_layerLocked(item) { try { return item.itemLayer.locked === true; } catch (e) { return false; } }
// true when the item sits (directly or inside a group) in an anchored position in text
function __ct_isAnchored(item) {
  var p = null;
  try { p = item.parent; } catch (e) { return false; }
  for (var d = 0; d < 8 && p; d++) {
    var t = __tp_type(p);
    if (t === 'Character') return true;
    if (t === 'Spread' || t === 'MasterSpread' || t === 'Page' || t === 'Document' || t === 'Application') return false;
    try { p = p.parent; } catch (e2) { return false; }
  }
  return false;
}
function __ct_swapItem(item, mode, dryRun, R) {
  if (R.seenItems[item.id]) return;
  R.seenItems[item.id] = true;
  var F = R.F, type = __tp_type(item);
  if (__ct_isAnchored(item)) R.anchored.push(item);
  var itemLocked = false;
  try { itemLocked = item.locked === true; } catch (e) {}
  var layerLocked = __ct_layerLocked(item);
  var touches = false;
  try { touches = !!(__ct_match(item.fillColor, F) || __ct_match(item.strokeColor, F)); } catch (e0) {}
  // a locked layer blocks every edit; a locked item blocks its own attributes but its text stays editable
  if (layerLocked) { if (touches || type === 'TextFrame') R.skippedLocked.push(item.id); return; }
  if (itemLocked && touches) R.skippedLocked.push(item.id);
  var os = null;
  try { os = item.appliedObjectStyle; } catch (e1) {}
  var pairs = [['fillColor', 'pageItemFill', 'enableFill'], ['strokeColor', 'pageItemStroke', 'enableStroke'], ['gapColor', 'pageItemGap', 'enableStroke']];
  for (var p = 0; p < pairs.length && !itemLocked; p++) {
    var cur = null;
    try { cur = item[pairs[p][0]]; } catch (e2) { continue; }
    var m = __ct_match(cur, F);
    if (!m) continue;
    if (mode === 'localOnly' && os) {
      var od = false;
      try { od = os[pairs[p][2]] === true && !!__ct_match(os[pairs[p][0]], F); } catch (e3) {}
      if (od) { __ct_derived(R, pairs[p][1], os, 'object'); continue; }
    }
    try { var tgt = __ct_target(m, R, dryRun); if (!dryRun) item[pairs[p][0]] = tgt; __ct_hit(R, pairs[p][1], m); }
    catch (e4) { R.warnings.push(type + ' ' + item.id + ' ' + pairs[p][0] + ': ' + __ct_err(e4)); }
  }
  if (type === 'TextFrame') {
    var stId = null;
    try { stId = item.parentStory.id; } catch (e5) {}
    if (stId !== null && R.storyIds[stId]) return; // whole story handled via scope.storyIds
    if (R.seenFrames[item.id]) return;
    R.seenFrames[item.id] = true;
    try { __ct_swapText(item.texts[0], mode, dryRun, R, 'frame ' + item.id); } catch (e6) { R.warnings.push('frame ' + item.id + ': ' + __ct_err(e6)); }
    try { __ct_swapTables(item.tables, mode, dryRun, R, 'frame ' + item.id); } catch (e7) {}
  }
}
function __ct_swapStyle(st, attrs, dryRun, R, key) {
  for (var a = 0; a < attrs.length; a++) {
    var rd = __ct_read(st, attrs[a]);
    if (!rd.ok) {
      // r4-B1: never swallow a failed read silently (a stale style reference made paragraph-only colours vanish)
      var sp = '?';
      try { sp = __tp_stylePath(st); } catch (eP) {}
      R.styleReadFailed.push({ style: sp, prop: attrs[a], error: rd.err });
      R.warnings.push('cannot read style ' + sp + ' ' + attrs[a] + ': ' + rd.err);
      continue;
    }
    var v = rd.v;
    var m = __ct_match(v, R.F);
    if (!m) continue;
    try {
      var tgt = __ct_target(m, R, dryRun);
      if (!dryRun) st[attrs[a]] = tgt;
      __ct_hit(R, key, m);
      R.styles.push({ style: __tp_stylePath(st), id: st.id, prop: attrs[a], from: __ct_swName(v), to: __ct_swName(tgt) });
    } catch (e2) { R.warnings.push('style ' + __tp_stylePath(st) + ' ' + attrs[a] + ': ' + __ct_err(e2)); }
  }
}
// Anchored items in scope (incl. children of anchored groups) whose fill/stroke is
// a swatch other than toSwatch (or its tints), a source swatch, Paper, None,
// Black or Registration: icons in another accent colour the user may want mapped.
function __ct_offColour(R) {
  var out = [];
  for (var i = 0; i < R.anchored.length && out.length < 200; i++) {
    var it = R.anchored[i], f = null, s = null, bad = false;
    try { if (!it.isValid) continue; } catch (e) { continue; }
    try { f = it.fillColor; } catch (e1) {}
    try { s = it.strokeColor; } catch (e2) {}
    var cs = [f, s];
    for (var c = 0; c < cs.length; c++) {
      if (!cs[c] || typeof cs[c] !== 'object' || __ct_neutral(cs[c]) || __ct_isTo(cs[c], R.to) || __ct_match(cs[c], R.F)) continue;
      bad = true;
    }
    if (!bad) continue;
    var pg = null;
    try { pg = it.parentPage ? String(it.parentPage.name) : null; } catch (e3) {}
    out.push({ id: it.id, type: __tp_type(it), page: pg, fill: __ct_swName(f), stroke: __ct_swName(s) });
  }
  return out;
}
// Resolve the JSON scope into DOM objects (throws on any bad reference).
function __ct_resolveScope(doc, sc) {
  var out = { masters: [], pages: [], stories: [], pstyles: [], cstyles: [], ostyles: [] }, i;
  sc = sc || {};
  var ma = __tp_arr(sc.masterNames); for (i = 0; i < ma.length; i++) out.masters.push(__ct_findMaster(doc, ma[i]));
  var pa = __tp_arr(sc.pageIndexes); for (i = 0; i < pa.length; i++) out.pages.push(__tp_requirePage(doc, pa[i]));
  var sa = __tp_arr(sc.storyIds);
  for (i = 0; i < sa.length; i++) { var s = doc.stories.itemByID(Number(sa[i])); if (!__tp_valid(s)) throw new Error('story not found: id ' + sa[i]); out.stories.push(s); }
  var ps = __tp_arr(sc.paragraphStyleIds); for (i = 0; i < ps.length; i++) out.pstyles.push(__tp_requireStyle(doc, 'paragraph', ps[i]));
  var cs = __tp_arr(sc.characterStyleIds); for (i = 0; i < cs.length; i++) out.cstyles.push(__tp_requireStyle(doc, 'character', cs[i]));
  var os = __tp_arr(sc.objectStyleIds); for (i = 0; i < os.length; i++) out.ostyles.push(__tp_requireStyle(doc, 'object', os[i]));
  return out;
}

// F: source swatch or array of source swatches; to: target swatch.
function __ct_swap(doc, F, to, scope, mode, dryRun) {
  __CT_DOC = doc;
  F = __tp_arr(F);
  to = __ct_typed(to);
  var R = { doc: doc, F: F, to: to, counts: __ct_counts(), styleDerived: __ct_counts(), viaScopedStyle: __ct_counts(), per: [],
    skippedLocked: [], warnings: [], styles: [], styleReadFailed: [], seenItems: {}, seenFrames: {}, storyIds: {}, scopeStyleIds: {},
    tintCache: {}, tintsCreated: [], tintsToCreate: [], tintHits: 0, grepProtected: 0, grepDerived: 0, grepParagraphs: 0,
    derivedFrom: {}, nestedCache: {}, anchored: [], fromCS: __ct_fromCharStyles(doc, F) };
  var i, j, items;
  for (i = 0; i < F.length; i++) R.per.push(0);
  for (i = 0; i < scope.pstyles.length; i++) R.scopeStyleIds['paragraph:' + scope.pstyles[i].id] = true;
  for (i = 0; i < scope.cstyles.length; i++) R.scopeStyleIds['character:' + scope.cstyles[i].id] = true;
  for (i = 0; i < scope.ostyles.length; i++) R.scopeStyleIds['object:' + scope.ostyles[i].id] = true;
  for (i = 0; i < scope.stories.length; i++) R.storyIds[scope.stories[i].id] = true;
  for (i = 0; i < scope.masters.length; i++) { items = scope.masters[i].allPageItems; for (j = 0; j < items.length; j++) __ct_swapItem(items[j], mode, dryRun, R); }
  for (i = 0; i < scope.pages.length; i++) { items = scope.pages[i].allPageItems; for (j = 0; j < items.length; j++) __ct_swapItem(items[j], mode, dryRun, R); }
  for (i = 0; i < scope.stories.length; i++) {
    var st = scope.stories[i];
    __ct_swapText(st.texts[0], mode, dryRun, R, 'story ' + st.id);
    try { __ct_swapTables(st.tables, mode, dryRun, R, 'story ' + st.id); } catch (e) {}
    var anchored = [];
    try { anchored = st.allPageItems; } catch (e2) { anchored = []; }
    for (j = 0; j < anchored.length; j++) __ct_swapItem(anchored[j], mode, dryRun, R);
  }
  for (i = 0; i < scope.pstyles.length; i++) __ct_swapStyle(scope.pstyles[i], __CT_PSTYLE_ATTRS, dryRun, R, 'paragraphStyleProps');
  for (i = 0; i < scope.cstyles.length; i++) __ct_swapStyle(scope.cstyles[i], __CT_CSTYLE_ATTRS, dryRun, R, 'characterStyleProps');
  for (i = 0; i < scope.ostyles.length; i++) __ct_swapStyle(scope.ostyles[i], __CT_OSTYLE_ATTRS, dryRun, R, 'objectStyleProps');
  var per = [];
  for (i = 0; i < F.length; i++) per.push({ swatch: String(F[i].name), id: F[i].id, count: R.per[i] });
  var derivedList = [];
  for (var dk in R.derivedFrom) if (R.derivedFrom.hasOwnProperty(dk)) derivedList.push({ style: dk, count: R.derivedFrom[dk] });
  derivedList.sort(function (x, y) { return y.count - x.count; });
  var res = { counts: R.counts, styleDerived: R.styleDerived, viaScopedStyle: R.viaScopedStyle, perSource: per,
    tintHits: R.tintHits, tintsCreated: R.tintsCreated, grepProtected: R.grepProtected, grepDerived: R.grepDerived,
    derivedFromStyles: derivedList.slice(0, 50), offColourItems: __ct_offColour(R), styleChanges: R.styles, styleReadFailed: R.styleReadFailed.slice(0, 100),
    skippedLocked: { count: R.skippedLocked.length, ids: R.skippedLocked.slice(0, 50) } };
  if (dryRun) res.tintsToCreate = R.tintsToCreate;
  if (R.grepProtected > 0) R.warnings.push(R.grepProtected + ' character(s) in ' + R.grepParagraphs + ' text object(s) with GREP/nested styles were left unchanged because their effective colour (after GREP/nested styles) is not the source colour (grepProtected).');
  if (R.grepDerived > 0) R.warnings.push(R.grepDerived + ' character(s) get the source colour from a GREP/nested character style; they were not overridden locally (a local override does not beat the GREP style). Recolour or duplicate that character style (see derivedFromStyles).');
  if (res.offColourItems.length > 0) R.warnings.push(res.offColourItems.length + ' anchored item(s) in scope use another accent swatch (offColourItems); add that swatch to fromSwatch to recolour them too.');
  res.warnings = R.warnings.slice(0, 100);
  if (__ct_sum(R.styleDerived) > 0 && mode === 'localOnly') res.hint = 'styleDerived counts colour that comes from paragraph/character/object styles (named in derivedFromStyles) and was left unchanged (no local overrides were added). Add those styles to scope.paragraphStyleIds / characterStyleIds / objectStyleIds, or pass overrideMode:"all".';
  return res;
}

// ── style remap (theme_chapter) ─────────────────────────────────────────────
// maps[kind][srcId] = { src, dup } (dup null in a dry run)
function __ct_newMaps() { return { paragraph: {}, character: {}, object: {}, n: { paragraph: 0, character: 0, object: 0 } }; }
function __ct_mapAdd(maps, kind, src, dup) { if (!maps[kind].hasOwnProperty(String(src.id))) maps.n[kind]++; maps[kind][String(src.id)] = { src: src, dup: dup }; }
function __ct_mapGet(maps, kind, st) {
  if (!st || typeof st !== 'object') return null;
  var id = null;
  try { id = st.id; } catch (e) { return null; }
  if (id === null || id === undefined) return null;
  return maps[kind].hasOwnProperty(String(id)) ? maps[kind][String(id)] : null;
}
// Re-point references INSIDE the duplicated styles to the duplicates:
// nested/GREP/line char styles, bullet/numbering char style, nextStyle, basedOn,
// object style paragraph style. Styles that were not duplicated are never edited.
function __ct_remapStyleRefs(list, maps, dryRun) {
  var out = { count: 0, changes: [], warnings: [] };
  function ref(owner, prop, kind, L, label) {
    var v = null;
    try { v = owner[prop]; } catch (e) { return; }
    var h = __ct_mapGet(maps, kind, v);
    if (!h) return;
    if (dryRun && prop === 'nextStyle' && v.id === L.src.id) return; // self-reference: handled by __ct_dupStyle
    try {
      if (!dryRun) owner[prop] = h.dup;
      out.count++;
      out.changes.push({ style: __tp_stylePath(L.style), ref: label, from: __tp_stylePath(h.src), to: h.dup ? __tp_stylePath(h.dup) : '(duplicate)' });
    } catch (e2) { out.warnings.push('style ' + __tp_stylePath(L.style) + ' ' + label + ': ' + __ct_err(e2)); }
  }
  for (var i = 0; i < list.length; i++) {
    var L = list[i], st = L.style;
    if (!st) continue;
    if (L.kind === 'paragraph') {
      var refs = __ct_nestedRefs(st);
      for (var r = 0; r < refs.length; r++) ref(refs[r].entry, 'appliedCharacterStyle', 'character', L, refs[r].kind + '[' + refs[r].index + '].appliedCharacterStyle');
      ref(st, 'bulletsCharacterStyle', 'character', L, 'bulletsCharacterStyle');
      ref(st, 'numberingCharacterStyle', 'character', L, 'numberingCharacterStyle');
      ref(st, 'nextStyle', 'paragraph', L, 'nextStyle');
      ref(st, 'basedOn', 'paragraph', L, 'basedOn');
    } else if (L.kind === 'character') {
      ref(st, 'basedOn', 'character', L, 'basedOn');
    } else {
      ref(st, 'basedOn', 'object', L, 'basedOn');
      ref(st, 'appliedParagraphStyle', 'paragraph', L, 'appliedParagraphStyle');
    }
  }
  return out;
}
function __ct_remapText(textObj, maps, dryRun, RM, label) {
  var base = 0, endEx = 0;
  try { base = textObj.insertionPoints[0].index; endEx = textObj.insertionPoints[-1].index; } catch (e) { return; }
  if (endEx <= base) return;
  if (maps.n.character > 0) {
    var col = textObj.textStyleRanges;
    if (col.length > 0) {
      var ev = col.everyItem(), idx = __tp_arr(ev.index), cs = __ct_arrProp(ev, 'appliedCharacterStyle'), spans = [];
      if (cs && cs.length === idx.length) {
        for (var i = 0; i < idx.length; i++) {
          var h = __ct_mapGet(maps, 'character', cs[i]);
          if (!h) continue;
          var s = Math.max(idx[i], base), e = (i + 1 < idx.length ? idx[i + 1] : endEx) - 1;
          if (e > endEx - 1) e = endEx - 1;
          if (e < s) continue;
          spans.push([s - base, e - base, h]);
        }
      }
      // character indexes do not move when a character style is applied
      for (var k = 0; k < spans.length; k++) {
        try { if (!dryRun) textObj.characters.itemByRange(spans[k][0], spans[k][1]).applyCharacterStyle(spans[k][2].dup); RM.characterRanges++; }
        catch (e1) { RM.warnings.push(label + ': character style chars ' + spans[k][0] + '-' + spans[k][1] + ': ' + __ct_err(e1)); }
      }
    }
  }
  if (maps.n.paragraph > 0) {
    var paras = textObj.paragraphs;
    if (paras.length > 0) {
      var pst = __ct_arrProp(paras.everyItem(), 'appliedParagraphStyle');
      if (pst) {
        for (var j = 0; j < pst.length; j++) {
          var ph = __ct_mapGet(maps, 'paragraph', pst[j]);
          if (!ph) continue;
          // clearingOverrides false: local overrides and character styles stay
          try { if (!dryRun) paras[j].applyParagraphStyle(ph.dup, false); RM.paragraphs++; }
          catch (e2) { RM.warnings.push(label + ': paragraph ' + j + ': ' + __ct_err(e2)); }
        }
      }
    }
  }
}
function __ct_remapTables(tables, maps, dryRun, RM, label) {
  for (var t = 0; t < tables.length; t++) {
    var cells = tables[t].cells;
    for (var c = 0; c < cells.length; c++) { try { __ct_remapText(cells[c].texts[0], maps, dryRun, RM, label + ' table ' + t + ' cell ' + c); } catch (e) {} }
  }
}
function __ct_remapItem(item, maps, dryRun, RM) {
  if (RM.seen[item.id]) return;
  RM.seen[item.id] = true;
  var layerLocked = __ct_layerLocked(item), itemLocked = false;
  try { itemLocked = item.locked === true; } catch (e) {}
  if (maps.n.object > 0) {
    var os = null;
    try { os = item.appliedObjectStyle; } catch (e1) {}
    var oh = __ct_mapGet(maps, 'object', os);
    if (oh) {
      var withPara = false;
      try { withPara = os.enableParagraphStyle === true; } catch (e2) {}
      if (layerLocked || itemLocked) RM.skippedLocked++;
      else if (withPara) RM.warnings.push('item ' + item.id + ': object style ' + __tp_stylePath(os) + ' applies a paragraph style; applying the duplicate would restyle its text, so it was NOT re-pointed. Apply it manually.');
      else { try { if (!dryRun) item.applyObjectStyle(oh.dup, false, false); RM.objects++; } catch (e3) { RM.warnings.push('item ' + item.id + ': object style: ' + __ct_err(e3)); } }
    }
  }
  if (__tp_type(item) !== 'TextFrame') return;
  var stId = null;
  try { stId = item.parentStory.id; } catch (e4) {}
  if (stId !== null && RM.storyIds[stId]) return;
  if (layerLocked) { RM.skippedLocked++; return; }
  __ct_remapText(item.texts[0], maps, dryRun, RM, 'frame ' + item.id);
  try { __ct_remapTables(item.tables, maps, dryRun, RM, 'frame ' + item.id); } catch (e5) {}
}
// tg: { masters: [], pages: [], stories: [] }. Masters: their stories in full
// plus all page items; pages: page items and the frame text range; stories: in full.
function __ct_remap(maps, tg, dryRun) {
  var RM = { paragraphs: 0, characterRanges: 0, objects: 0, skippedLocked: 0, warnings: [], seen: {}, storyIds: {} };
  var i, j, stories = [];
  if (maps.n.paragraph + maps.n.character + maps.n.object > 0) {
    for (i = 0; i < tg.stories.length; i++) stories.push(tg.stories[i]);
    for (i = 0; i < tg.masters.length; i++) { var ms = __ct_spreadStories(tg.masters[i]); for (j = 0; j < ms.length; j++) stories.push(ms[j]); }
    for (i = 0; i < stories.length; i++) {
      var st = stories[i];
      if (RM.storyIds[st.id]) continue;
      RM.storyIds[st.id] = true;
      __ct_remapText(st.texts[0], maps, dryRun, RM, 'story ' + st.id);
      try { __ct_remapTables(st.tables, maps, dryRun, RM, 'story ' + st.id); } catch (e) {}
      var an = [];
      try { an = st.allPageItems; } catch (e1) { an = []; }
      for (j = 0; j < an.length; j++) __ct_remapItem(an[j], maps, dryRun, RM);
    }
    var items;
    for (i = 0; i < tg.masters.length; i++) { items = tg.masters[i].allPageItems; for (j = 0; j < items.length; j++) __ct_remapItem(items[j], maps, dryRun, RM); }
    for (i = 0; i < tg.pages.length; i++) { items = tg.pages[i].allPageItems; for (j = 0; j < items.length; j++) __ct_remapItem(items[j], maps, dryRun, RM); }
  }
  return { paragraphs: RM.paragraphs, characterRanges: RM.characterRanges, objects: RM.objects, skippedLocked: RM.skippedLocked, stories: stories.length, warnings: RM.warnings.slice(0, 50) };
}
// After the swap: every colour-bearing property of a duplicated style that is
// still (a tint of) a source swatch, plus nested/GREP/bullet/numbering character
// styles referenced by a duplicated paragraph style that were NOT duplicated and
// still carry a source colour.
// Unreadable properties are returned in unreadable[] (never silently skipped), and
// every colour prop that is (a tint of) a source swatch in the SOURCE style must be
// the target (or a tint of it) in the duplicate (notSwapped[]), whatever the
// duplicate's reads say. Returns { hits, unreadable, notSwapped }.
function __ct_styleAudit(list, F, dupIds, to) {
  var out = [], unreadable = [], notSwapped = [];
  function check(st, attrs, owner, via) {
    for (var a = 0; a < attrs.length; a++) {
      var rd = __ct_read(st, attrs[a]);
      var pname = via ? via + ' -> ' + __tp_stylePath(st) + '.' + attrs[a] : attrs[a];
      if (!rd.ok) { unreadable.push({ style: __tp_stylePath(owner), id: owner.id, prop: pname, error: rd.err }); continue; }
      var v = rd.v;
      if (!__ct_match(v, F)) continue;
      out.push({ style: __tp_stylePath(owner), id: owner.id, prop: pname, colour: __ct_swName(v) });
    }
  }
  for (var i = 0; i < list.length; i++) {
    var L = list[i];
    if (!L.style) continue;
    var attrsL = __ct_styleAttrs(L.kind);
    check(L.style, attrsL, L.style, null);
    if (L.src && to) {
      for (var sa = 0; sa < attrsL.length; sa++) {
        var rs = __ct_read(L.src, attrsL[sa]);
        if (!rs.ok || !__ct_match(rs.v, F)) continue;
        var rdup = __ct_read(L.style, attrsL[sa]);
        if (rdup.ok && __ct_isTo(rdup.v, to)) continue;
        notSwapped.push({ style: __tp_stylePath(L.style), id: L.style.id, prop: attrsL[sa], source: __ct_swName(rs.v), now: rdup.ok ? __ct_swName(rdup.v) : 'unreadable: ' + rdup.err });
      }
    }
    if (L.kind !== 'paragraph') continue;
    var refs = __ct_nestedRefs(L.style), linked = [];
    for (var r = 0; r < refs.length; r++) linked.push([refs[r].cs, refs[r].kind + '[' + refs[r].index + ']']);
    try { linked.push([L.style.bulletsCharacterStyle, 'bulletsCharacterStyle']); } catch (e1) {}
    try { linked.push([L.style.numberingCharacterStyle, 'numberingCharacterStyle']); } catch (e2) {}
    try { linked.push([L.style.dropCapCharacterStyle, 'dropCapCharacterStyle']); } catch (e4) {}
    for (var k = 0; k < linked.length; k++) {
      var cs = linked[k][0];
      if (__ct_isNoneStyle(cs) || typeof cs !== 'object') continue;
      var cid = null;
      try { cid = cs.id; } catch (e3) { continue; }
      if (dupIds[cid]) continue;
      check(cs, __CT_CSTYLE_ATTRS, L.style, linked[k][1] + ' (not duplicated)');
    }
  }
  return { hits: out, unreadable: unreadable, notSwapped: notSwapped };
}
// Every colour-bearing property of the duplicated styles after the swap, with
// what it now holds: { checked: n, props: [{ style, prop, colour, state }] } where
// state is 'target' (toSwatch or a tint of it), 'source' (still a source swatch,
// also in styleColourAudit), 'neutral' (Paper/Black/None/Registration/Text Color)
// or 'other' (another swatch: a different accent colour, or a near-duplicate of
// the source colour that is not one of the fromSwatch entries).
function __ct_styleColourReport(list, F, to) {
  var out = { checked: 0, props: [], other: [], unreadable: [] };
  for (var i = 0; i < list.length; i++) {
    var L = list[i];
    if (!L.style) continue;
    var attrs = __ct_styleAttrs(L.kind);
    for (var a = 0; a < attrs.length; a++) {
      var rd = __ct_read(L.style, attrs[a]);
      if (!rd.ok) { out.unreadable.push({ style: __tp_stylePath(L.style), id: L.style.id, prop: attrs[a], error: rd.err }); continue; }
      var v = rd.v;
      out.checked++;
      if (!v || typeof v !== 'object') continue; // enum / 'Text Color' string
      var state = __ct_match(v, F) ? 'source' : (__ct_isTo(v, to) ? 'target' : (__ct_neutral(v) ? 'neutral' : 'other'));
      if (state === 'neutral') continue;
      var row = { style: __tp_stylePath(L.style), id: L.style.id, prop: attrs[a], colour: __ct_swName(v), state: state };
      out.props.push(row);
      if (state === 'other') out.other.push(row);
    }
  }
  return out;
}
// Text frames of a (master) spread whose story is overset after the theme steps.
function __ct_oversetFrames(spread) {
  var out = [], stories = __ct_spreadStories(spread);
  for (var i = 0; i < stories.length; i++) {
    if (!__ct_storyOverset(stories[i])) continue;
    var fr = __ct_lastFrame(stories[i]);
    out.push({ story: stories[i].id, frameId: fr ? fr.id : null, frameName: fr ? __tp_name(fr) : '', text: __ct_snip(stories[i].contents) });
  }
  return out;
}
`;

const SCOPE_SCHEMA = {
  type: "object",
  description: "Where to recolour. At least one entry is required; nothing outside the scope is touched.",
  properties: {
    masterNames: { type: "array", items: { type: ["string", "number"] }, description: "Master spreads (full name 'C-Chapter 3', prefix, base name or id): all their page items and frame text" },
    pageIndexes: { type: "array", items: { type: "number" }, description: "0-based document page indexes: page items (incl. grouped/anchored) and the text of frames on those pages (frame range only)" },
    storyIds: { type: "array", items: { type: "number" }, description: "Whole stories incl. tables and anchored items" },
    paragraphStyleIds: { type: "array", items: { type: ["string", "number"] }, description: "Paragraph style definitions (id or group path)" },
    characterStyleIds: { type: "array", items: { type: ["string", "number"] }, description: "Character style definitions (id or group path)" },
    objectStyleIds: { type: "array", items: { type: ["string", "number"] }, description: "Object style definitions (id or group path)" },
  },
};

const OVERRIDE_MODE_SCHEMA = {
  type: "string",
  enum: ["localOnly", "all"],
  description:
    "localOnly (default): colour that comes from a paragraph/character/object style (incl. GREP/nested character styles) is NOT overridden locally (reported in styleDerived / derivedFromStyles); recolour the style instead. all: recolour every match, adding local overrides. In both modes characters whose EFFECTIVE colour after GREP/nested styles is not the source colour are never touched (grepProtected).",
};

const FROM_SWATCH_SCHEMA = {
  type: ["string", "number", "array"],
  items: { type: ["string", "number"] },
  description:
    "Swatch(es) to replace: name, id, or an array of them (e.g. the chapter colour plus an accent colour used by icons). Tints of these swatches are matched too and mapped to a tint of toSwatch with the same tint value (created when missing, reported in tintsCreated).",
};

const FROM_SWATCHES_SCHEMA = {
  type: "array",
  items: { type: ["string", "number"] },
  description: "Alias of fromSwatch as an array; merged with fromSwatch when both are given.",
};

const TEXT_REPLACE_SCHEMA = {
  type: "array",
  description: "Literal (non-GREP) find/replace applied in order to the text of the NEW master only (e.g. running head 'Chapter 2' -> 'Chapter 3').",
  items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
};

type TextReplace = { find: string; replace: string };

const TEXT_REPLACE_OVERSET_SCHEMA = {
  type: "string",
  enum: ["rollback", "keep"],
  description:
    "What to do when a textReplace replacement pushes a master text frame (e.g. the running head) into overset: rollback (default) reverts that " +
    "replacement (text and character formatting) and reports it in master.mismatches; keep leaves it and reports it (the frame then hides text).",
};

function parseOversetPolicy(v: unknown): "rollback" | "keep" {
  if (v === undefined || v === null || v === "") return "rollback";
  if (v !== "rollback" && v !== "keep") throw new Error("textReplaceOverset must be rollback or keep");
  return v;
}

function parseTextReplace(v: unknown): TextReplace[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("textReplace must be an array of {find, replace}");
  return v.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (!o || typeof o.find !== "string" || o.find === "") throw new Error(`textReplace[${i}].find must be a non-empty string`);
    if (typeof o.replace !== "string") throw new Error(`textReplace[${i}].replace must be a string`);
    return { find: o.find, replace: o.replace };
  });
}

function parsePrefix(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error("newNamePrefix is required");
  const p = v.trim();
  if (p.length > 4) throw new Error(`newNamePrefix must be at most 4 characters (InDesign limit), got '${p}'`);
  if (p.includes("-")) throw new Error("newNamePrefix must not contain '-'");
  return p;
}

function parseBaseName(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error("newBaseName is required");
  return v.trim();
}

function parseMode(v: unknown): "localOnly" | "all" {
  if (v === undefined || v === null || v === "") return "localOnly";
  if (v !== "localOnly" && v !== "all") throw new Error("overrideMode must be localOnly or all");
  return v;
}

function intArray(v: unknown, name: string, min = 0): number[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`);
  return v.map((x, i) => {
    const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min) throw new Error(`${name}[${i}] must be an integer >= ${min} (got ${JSON.stringify(x)})`);
    return n;
  });
}

function refArray(v: unknown, name: string): (string | number)[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`);
  return v.map((x, i) => {
    if ((typeof x !== "string" || x === "") && typeof x !== "number") throw new Error(`${name}[${i}] must be an id or name`);
    return x;
  });
}

interface Scope {
  masterNames?: (string | number)[];
  pageIndexes?: number[];
  storyIds?: number[];
  paragraphStyleIds?: (string | number)[];
  characterStyleIds?: (string | number)[];
  objectStyleIds?: (string | number)[];
}

function parseScope(v: unknown, allowEmpty: boolean): Scope {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) throw new Error("scope must be an object");
  const s: Scope = {
    masterNames: refArray(o.masterNames, "scope.masterNames"),
    pageIndexes: intArray(o.pageIndexes, "scope.pageIndexes"),
    storyIds: intArray(o.storyIds, "scope.storyIds"),
    paragraphStyleIds: refArray(o.paragraphStyleIds, "scope.paragraphStyleIds"),
    characterStyleIds: refArray(o.characterStyleIds, "scope.characterStyleIds"),
    objectStyleIds: refArray(o.objectStyleIds, "scope.objectStyleIds"),
  };
  const any = Object.values(s).some((a) => Array.isArray(a) && a.length > 0);
  if (!any && !allowEmpty) throw new Error("scope must name at least one of masterNames, pageIndexes, storyIds, paragraphStyleIds, characterStyleIds, objectStyleIds");
  return s;
}

function swatchArg(v: unknown, name: string): string | number {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${name} is required`);
  return v;
}

/** fromSwatch (string | number | array) merged with fromSwatches (array). */
function fromSwatchList(args: Record<string, unknown>): (string | number)[] {
  const out: (string | number)[] = [];
  const add = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => out.push(swatchArg(x, `${name}[${i}]`)));
    else out.push(swatchArg(v, name));
  };
  add(args.fromSwatch, "fromSwatch");
  add(args.fromSwatches, "fromSwatches");
  if (out.length === 0) throw new Error("fromSwatch is required (a swatch name/id or an array of them)");
  return out;
}

export function registerChapterThemeTools(bridge: InDesignBridge) {
  return {
    duplicate_master_spread: {
      description:
        "Duplicate a master spread for a new chapter (one undo step). sourceName: full name ('B-Chapter 2'), prefix, base name or id. " +
        "The copy gets newNamePrefix + newBaseName (prefix must be unused). textReplace does literal find/replace in the copy's text only " +
        "(e.g. running head); a replacement that pushes a frame into overset is rolled back and reported in mismatches (textReplaceOverset). " +
        "dryRun reports the source, the new name and the match counts without changing anything.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sourceName: { type: ["string", "number"], description: "Source master: full name, prefix, base name or id" },
          newNamePrefix: { type: "string", description: "Prefix of the new master (1-4 characters, unused)" },
          newBaseName: { type: "string", description: "Base name of the new master (e.g. 'Chapter 3')" },
          textReplace: TEXT_REPLACE_SCHEMA,
          textReplaceOverset: TEXT_REPLACE_OVERSET_SCHEMA,
          dryRun: { type: "boolean", description: "Report only. Default false" },
        },
        required: ["sourceName", "newNamePrefix", "newBaseName"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          if (args.sourceName === undefined || args.sourceName === null || args.sourceName === "") throw new Error("sourceName is required");
          const prefix = parsePrefix(args.newNamePrefix);
          const base = parseBaseName(args.newBaseName);
          const tr = parseTextReplace(args.textReplace);
          const ovp = parseOversetPolicy(args.textReplaceOverset);
          const dry = args.dryRun === true;
          return runTp(
            bridge,
            args,
            jsx`
              var warnings = [];
              var r = __ct_dupMaster(doc, ${jsStr(args.sourceName)}, ${jsStr(prefix)}, ${jsStr(base)}, ${jsJson(tr)}, ${dry}, warnings, ${jsStr(ovp)});
              var out = r.report; out.dryRun = ${dry}; out.warnings = warnings;
              return __ok(out);`,
            dry ? { prelude: CT_PRELUDE } : { prelude: CT_PRELUDE, undoName: "duplicate_master_spread", mutating: true }
          );
        }),
    },

    swap_swatch_in_scope: {
      description:
        "Recolour fromSwatch (one or several swatches, tints included) -> toSwatch only inside scope (one undo step): page item " +
        "fill/stroke/gap (incl. grouped and anchored items), text fill/stroke/underline/strikethrough (+gap) colour, paragraph " +
        "shading/border/rule above/rule below (+gap) colour, table cell fill/edge strokes, and the colour properties of the listed " +
        "style definitions. A tint of a source swatch becomes the same tint of toSwatch (created when missing: tintsCreated). Text in " +
        "paragraphs with GREP/nested styles is judged by its effective colour, so GREP-applied colours (e.g. Black value text) are never " +
        "overridden (grepProtected). Locked items/layers are skipped and reported. Returns counts per item type and per source swatch " +
        "(perSource), styleDerived counts left alone in overrideMode localOnly with the styles responsible (derivedFromStyles), and " +
        "offColourItems: anchored items in scope coloured with a swatch other than toSwatch/Paper/None/Black. dryRun counts only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fromSwatch: FROM_SWATCH_SCHEMA,
          fromSwatches: FROM_SWATCHES_SCHEMA,
          toSwatch: { type: ["string", "number"], description: "Replacement swatch (name or id)" },
          scope: SCOPE_SCHEMA,
          overrideMode: OVERRIDE_MODE_SCHEMA,
          dryRun: { type: "boolean", description: "Count only. Default false" },
        },
        required: ["toSwatch", "scope"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const from = fromSwatchList(args);
          const to = swatchArg(args.toSwatch, "toSwatch");
          const scope = parseScope(args.scope, false);
          const mode = parseMode(args.overrideMode);
          const dry = args.dryRun === true;
          return runTp(
            bridge,
            args,
            jsx`
              var F = __ct_swatches(doc, ${jsJson(from)}, 'fromSwatch');
              var to = __ct_swatch(doc, ${jsJson(to)}, 'toSwatch');
              for (var f = 0; f < F.length; f++) if (F[f].id === to.id) return __fail('fromSwatch ' + F[f].name + ' is the same swatch as toSwatch');
              var sc = __ct_resolveScope(doc, ${jsJson(scope)});
              var res = __ct_swap(doc, F, to, sc, ${jsStr(mode)}, ${dry});
              var names = [];
              for (var n = 0; n < F.length; n++) names.push(String(F[n].name));
              res.dryRun = ${dry}; res.from = F.length === 1 ? names[0] : names; res.to = to.name; res.overrideMode = ${jsStr(mode)};
              return __ok(res);`,
            dry ? { prelude: CT_PRELUDE } : { prelude: CT_PRELUDE, undoName: "swap_swatch_in_scope", mutating: true }
          );
        }),
    },

    theme_chapter: {
      description:
        "Theme a new chapter in ONE undo step: (1) duplicate_master_spread (sourceMaster -> newNamePrefix/newBaseName, textReplace), " +
        "(2) duplicate the listed styles into their groupPath (e.g. 'Regular set/Chapter 3'), (3) re-point to the duplicates: the new " +
        "master's paragraphs (applyParagraphStyle, local overrides kept), character style runs and object styles, plus references " +
        "inside the duplicated styles (nested/GREP/line styles, bullet/numbering char style, nextStyle, basedOn); with remapScope:true " +
        "also the extra scope; (4) swap fromSwatch (one or several, tints included) -> toSwatch on the new master, the duplicated styles " +
        "and any extra scope. Returns remapped counts, styleColourAudit (colour props of duplicated styles, or of non-duplicated char " +
        "styles they reference, still in the source colour; checks fill/stroke, paragraph shading/border, rule above/below, underline, " +
        "strikethrough and their gap colours, tints included), styleColours (every colour prop of the duplicates and what it now holds), " +
        "masterAfterSwap (source colour still reaching the new master, with the styles responsible, plus oversetFrames), mismatches " +
        "(textReplace that would overset a master frame - rolled back by default, see textReplaceOverset - audit hits, styleColourNotSwapped: a colour prop that is the source colour in the source style but not the new colour in the duplicate, styleColourUnreadable: a colour prop that could not be read, overset frames) and offColourItems. Everything is validated (dry pass) before the first change. dryRun reports what would " +
        "happen (measured on the source master / source styles). Apply the new master to pages with apply_master.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sourceMaster: { type: ["string", "number"], description: "Source master: full name, prefix, base name or id" },
          newNamePrefix: { type: "string", description: "Prefix of the new master (1-4 characters, unused)" },
          newBaseName: { type: "string", description: "Base name of the new master" },
          textReplace: TEXT_REPLACE_SCHEMA,
          textReplaceOverset: TEXT_REPLACE_OVERSET_SCHEMA,
          fromSwatch: { ...FROM_SWATCH_SCHEMA, description: "Source chapter colour swatch(es): name, id or array. " + FROM_SWATCH_SCHEMA.description },
          fromSwatches: FROM_SWATCHES_SCHEMA,
          toSwatch: { type: ["string", "number"], description: "New chapter colour swatch" },
          styles: {
            type: "array",
            description:
              "Styles to duplicate for the chapter; their colour properties are swapped and the new master (and, with remapScope, the extra scope) is re-pointed to them. " +
              "List the character styles used by nested/GREP styles of the listed paragraph styles too, so those references are re-pointed.",
            items: {
              type: "object",
              properties: {
                styleType: { type: "string", enum: ["paragraph", "character", "object"], description: "Default paragraph" },
                source: { type: ["string", "number"], description: "Source style id or group path" },
                newName: { type: "string" },
                groupPath: { type: "string", description: "Target group path (created when missing). Default: the source style's group" },
              },
              required: ["source", "newName"],
            },
          },
          scope: { ...SCOPE_SCHEMA, description: "Extra scope recoloured in addition to the new master and duplicated styles (optional)" },
          remapScope: {
            type: "boolean",
            description: "Also re-point paragraphs/character runs/object styles in the extra scope (masters, pages, stories) from the source styles to the duplicates. Default false (only the new master is re-pointed).",
          },
          overrideMode: OVERRIDE_MODE_SCHEMA,
          dryRun: { type: "boolean", description: "Report only. Default false" },
        },
        required: ["sourceMaster", "newNamePrefix", "newBaseName", "toSwatch"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          if (args.sourceMaster === undefined || args.sourceMaster === null || args.sourceMaster === "") throw new Error("sourceMaster is required");
          const prefix = parsePrefix(args.newNamePrefix);
          const base = parseBaseName(args.newBaseName);
          const tr = parseTextReplace(args.textReplace);
          const ovp = parseOversetPolicy(args.textReplaceOverset);
          const from = fromSwatchList(args);
          const to = swatchArg(args.toSwatch, "toSwatch");
          const scope = parseScope(args.scope, true);
          const mode = parseMode(args.overrideMode);
          const dry = args.dryRun === true;
          if (args.remapScope !== undefined && args.remapScope !== null && typeof args.remapScope !== "boolean") throw new Error("remapScope must be a boolean");
          const remapScope = args.remapScope === true;
          const stylesIn = args.styles === undefined || args.styles === null ? [] : args.styles;
          if (!Array.isArray(stylesIn)) throw new Error("styles must be an array");
          const styles = stylesIn.map((e, i) => {
            const o = (e ?? {}) as Record<string, unknown>;
            const kind = o.styleType ?? "paragraph";
            if (kind !== "paragraph" && kind !== "character" && kind !== "object") throw new Error(`styles[${i}].styleType must be paragraph, character or object`);
            if (o.source === undefined || o.source === null || o.source === "") throw new Error(`styles[${i}].source is required`);
            if (typeof o.newName !== "string" || o.newName.trim() === "") throw new Error(`styles[${i}].newName is required`);
            if (o.newName.includes("/")) throw new Error(`styles[${i}].newName must not contain '/'; use groupPath`);
            return { kind, source: o.source, newName: o.newName.trim(), groupPath: typeof o.groupPath === "string" ? o.groupPath : "" };
          });
          return runTp(
            bridge,
            args,
            jsx`
              var styles = ${jsJson(styles)}, warnings = [];
              var REMAP_SCOPE = ${remapScope};
              var F = __ct_swatches(doc, ${jsJson(from)}, 'fromSwatch');
              var to = __ct_swatch(doc, ${jsJson(to)}, 'toSwatch');
              for (var f = 0; f < F.length; f++) if (F[f].id === to.id) return __fail('fromSwatch ' + F[f].name + ' is the same swatch as toSwatch');
              var extra = __ct_resolveScope(doc, ${jsJson(scope)});
              var srcStyles = [];
              for (var i = 0; i < styles.length; i++) srcStyles.push(__tp_requireStyle(doc, styles[i].kind, styles[i].source));
              // two duplicates with the same target path would clash with each other;
              // the same source listed twice would make the remap ambiguous
              var seenPaths = {}, seenSrc = {};
              for (var q = 0; q < styles.length; q++) {
                var pk = styles[q].kind + ':' + __ct_splitPath(styles[q].groupPath).join('/') + '/' + styles[q].newName;
                if (!styles[q].groupPath) pk = styles[q].kind + ':' + __ct_containerPath(srcStyles[q].parent) + '/' + styles[q].newName;
                if (seenPaths[pk]) return __fail('styles[' + q + '] duplicates the target of an earlier entry: ' + pk);
                seenPaths[pk] = true;
                var sk = styles[q].kind + ':' + srcStyles[q].id;
                if (seenSrc[sk]) return __fail('styles[' + q + '] duplicates the same source style as an earlier entry (' + __tp_stylePath(srcStyles[q]) + '); each source style can be duplicated once per chapter');
                seenSrc[sk] = true;
              }
              function kindKey(kind) { return kind === 'paragraph' ? 'pstyles' : (kind === 'character' ? 'cstyles' : 'ostyles'); }
              function remapTargets(master) {
                return { masters: [master].concat(REMAP_SCOPE ? extra.masters : []), pages: REMAP_SCOPE ? extra.pages : [], stories: REMAP_SCOPE ? extra.stories : [] };
              }
              // dry pass: validates every reference and name clash before anything changes
              var dm = __ct_dupMaster(doc, ${jsStr(args.sourceMaster)}, ${jsStr(prefix)}, ${jsStr(base)}, ${jsJson(tr)}, true, ${dry} ? warnings : [], ${jsStr(ovp)});
              var styleReports = [];
              for (var d = 0; d < styles.length; d++) styleReports.push(__ct_dupStyle(doc, styles[d].kind, srcStyles[d], styles[d].newName, styles[d].groupPath, true).report);
              var DRY = ${dry};
              if (DRY) {
                var dmaps = __ct_newMaps(), dlist = [];
                for (var s0 = 0; s0 < styles.length; s0++) { __ct_mapAdd(dmaps, styles[s0].kind, srcStyles[s0], null); dlist.push({ kind: styles[s0].kind, style: srcStyles[s0], src: srcStyles[s0] }); }
                var drm = __ct_remap(dmaps, remapTargets(dm.source), true);
                drm.styleRefs = __ct_remapStyleRefs(dlist, dmaps, true);
                var prev = { masters: [dm.source], pages: extra.pages, stories: extra.stories, pstyles: extra.pstyles.slice(0), cstyles: extra.cstyles.slice(0), ostyles: extra.ostyles.slice(0) };
                for (var m = 0; m < extra.masters.length; m++) prev.masters.push(extra.masters[m]);
                for (var s1 = 0; s1 < styles.length; s1++) prev[kindKey(styles[s1].kind)].push(srcStyles[s1]);
                var sw = __ct_swap(doc, F, to, prev, ${jsStr(mode)}, true);
                return __ok({ dryRun: true, master: dm.report, styles: styleReports, remapped: drm, swap: sw, swapMeasuredOn: 'source master and source styles', remapScope: REMAP_SCOPE, warnings: warnings });
              }
              var real = __ct_dupMaster(doc, ${jsStr(args.sourceMaster)}, ${jsStr(prefix)}, ${jsStr(base)}, ${jsJson(tr)}, false, warnings, ${jsStr(ovp)});
              var sc = { masters: [real.master], pages: extra.pages, stories: extra.stories, pstyles: extra.pstyles.slice(0), cstyles: extra.cstyles.slice(0), ostyles: extra.ostyles.slice(0) };
              for (var m2 = 0; m2 < extra.masters.length; m2++) sc.masters.push(extra.masters[m2]);
              var made = [], maps = __ct_newMaps(), dupList = [], dupIds = {};
              for (var k = 0; k < styles.length; k++) {
                var dup = __ct_dupStyle(doc, styles[k].kind, srcStyles[k], styles[k].newName, styles[k].groupPath, false);
                // r4-B1: re-resolve the duplicate by id (concrete) before remap / swap / audit
                var dupRe = __ct_styleById(doc, styles[k].kind, dup.report.id);
                if (!dupRe) return __fail('duplicate of ' + __tp_stylePath(srcStyles[k]) + ' (id ' + dup.report.id + ') cannot be found again by id');
                dup.style = dupRe;
                made.push(dup.report);
                sc[kindKey(styles[k].kind)].push(dup.style);
                __ct_mapAdd(maps, styles[k].kind, srcStyles[k], dup.style);
                dupList.push({ kind: styles[k].kind, style: dup.style, src: srcStyles[k] });
                dupIds[dup.style.id] = true;
              }
              // re-point references inside the duplicates, then the new master (and opt-in scope), THEN swap
              var refs = __ct_remapStyleRefs(dupList, maps, false);
              var rm = __ct_remap(maps, remapTargets(real.master), false);
              rm.styleRefs = refs;
              for (var w0 = 0; w0 < refs.warnings.length; w0++) warnings.push(refs.warnings[w0]);
              for (var w1 = 0; w1 < rm.warnings.length; w1++) warnings.push(rm.warnings[w1]);
              // re-resolve the duplicates again (remapping basedOn/nextStyle edits them) so swap and audits use fresh, concrete objects
              function refreshDups() {
                for (var rq = 0; rq < dupList.length; rq++) {
                  var fresh = __ct_styleById(doc, dupList[rq].kind, dupList[rq].style.id);
                  if (fresh) dupList[rq].style = fresh;
                }
                sc.pstyles = extra.pstyles.slice(0); sc.cstyles = extra.cstyles.slice(0); sc.ostyles = extra.ostyles.slice(0);
                for (var rq2 = 0; rq2 < dupList.length; rq2++) sc[kindKey(dupList[rq2].kind)].push(dupList[rq2].style);
              }
              refreshDups();
              var swr = __ct_swap(doc, F, to, sc, ${jsStr(mode)}, false);
              refreshDups();
              // audit 1: colour props of the duplicated styles (and non-duplicated char styles they reference)
              var mismatches = [];
              var mmMaster = real.report.mismatches || [];
              for (var mq = 0; mq < mmMaster.length; mq++) mismatches.push(mmMaster[mq]);
              // a style property the swap could not write (e.g. tint creation failed) must not disappear in swap.warnings
              for (var sw0 = 0; sw0 < swr.warnings.length; sw0++) if (/^style /.test(swr.warnings[sw0])) { warnings.push('swap: ' + swr.warnings[sw0]); mismatches.push({ type: 'styleColourWriteFailed', message: swr.warnings[sw0] }); }
              var srf = swr.styleReadFailed || [];
              for (var rf = 0; rf < srf.length; rf++) mismatches.push({ type: 'styleColourUnreadable', step: 'swap', style: srf[rf].style, prop: srf[rf].prop, error: srf[rf].error });
              var auditR = __ct_styleAudit(dupList, F, dupIds, to), audit = auditR.hits;
              for (var a1 = 0; a1 < audit.length; a1++) {
                if (a1 < 30) warnings.push('styleColourAudit: ' + audit[a1].style + ' ' + audit[a1].prop + ' is still ' + audit[a1].colour);
                mismatches.push({ type: 'styleColourAudit', style: audit[a1].style, id: audit[a1].id, prop: audit[a1].prop, colour: audit[a1].colour });
              }
              for (var a2 = 0; a2 < auditR.unreadable.length; a2++) {
                var ur = auditR.unreadable[a2];
                if (a2 < 30) warnings.push('styleColourAudit: cannot read ' + ur.style + ' ' + ur.prop + ': ' + ur.error);
                mismatches.push({ type: 'styleColourUnreadable', step: 'audit', style: ur.style, id: ur.id, prop: ur.prop, error: ur.error });
              }
              for (var a3 = 0; a3 < auditR.notSwapped.length; a3++) {
                var ns = auditR.notSwapped[a3];
                if (a3 < 30) warnings.push('styleColourAudit: ' + ns.style + ' ' + ns.prop + ' is ' + ns.source + ' in the source style but ' + ns.now + ' in the duplicate (expected ' + to.name + ' or a tint of it)');
                mismatches.push({ type: 'styleColourNotSwapped', style: ns.style, id: ns.id, prop: ns.prop, source: ns.source, now: ns.now });
                audit.push({ style: ns.style, id: ns.id, prop: ns.prop, colour: ns.now, sourceColour: ns.source, notSwapped: true });
              }
              // every colour-bearing property of the duplicates (fill/stroke, shading, border, rules, underline, strikethrough + gaps)
              var colourReport = __ct_styleColourReport(dupList, F, to);
              for (var u1 = 0; u1 < colourReport.unreadable.length; u1++) {
                var cu = colourReport.unreadable[u1], dupU = false;
                for (var u2 = 0; u2 < auditR.unreadable.length; u2++) if (auditR.unreadable[u2].id === cu.id && auditR.unreadable[u2].prop === cu.prop) dupU = true;
                if (!dupU) mismatches.push({ type: 'styleColourUnreadable', step: 'styleColours', style: cu.style, id: cu.id, prop: cu.prop, error: cu.error });
              }
              for (var o1 = 0; o1 < colourReport.other.length && o1 < 30; o1++) {
                var orow = colourReport.other[o1];
                warnings.push('styleColours: ' + orow.style + ' ' + orow.prop + ' is ' + orow.colour + ', neither the new chapter colour nor a source swatch; add it to fromSwatch if it is a chapter accent');
              }
              // audit 2: source colour still reaching the new master after the swap
              var post = __ct_swap(doc, F, to, { masters: [real.master], pages: [], stories: [], pstyles: [], cstyles: [], ostyles: [] }, 'localOnly', true);
              var leftLocal = __ct_sum(post.counts), leftStyled = __ct_sum(post.styleDerived);
              if (leftStyled > 0) {
                var dn = [];
                for (var p1 = 0; p1 < post.derivedFromStyles.length; p1++) dn.push(post.derivedFromStyles[p1].style);
                warnings.push('new master ' + real.report.name + ' still shows the source colour through style(s) that were not duplicated: ' + dn.join('; ') + '. Add them to styles[] (or recolour them deliberately).');
              }
              if (leftLocal > 0) warnings.push('new master ' + real.report.name + ' still has ' + leftLocal + ' local run(s)/item(s) in the source colour (locked items/layers or failed writes; see swap.skippedLocked / swap.warnings).');
              if (leftLocal > 0 || leftStyled > 0) mismatches.push({ type: 'masterAfterSwap', localRemaining: leftLocal, styleDerivedRemaining: leftStyled, derivedFromStyles: post.derivedFromStyles });
              // overset on the new master after ALL steps (style remap / recolour can reflow too); textReplace overset was handled above
              var overAfter = __ct_oversetFrames(real.master);
              for (var ov = 0; ov < overAfter.length; ov++) {
                var known = false;
                for (var mq2 = 0; mq2 < mmMaster.length; mq2++) if (mmMaster[mq2].story === overAfter[ov].story && mmMaster[mq2].action !== 'rolledBack') known = true;
                if (known) continue;
                overAfter[ov].type = 'masterOverset';
                mismatches.push(overAfter[ov]);
                warnings.push('new master ' + real.report.name + ': frame ' + overAfter[ov].frameId + (overAfter[ov].frameName ? ' (' + overAfter[ov].frameName + ')' : '') + ' is overset after theming (text: "' + overAfter[ov].text + '")');
              }
              return __ok({ dryRun: false, master: real.report, styles: made, remapped: rm, swap: swr, styleColourAudit: audit,
                styleColours: { checked: colourReport.checked, props: colourReport.props.slice(0, 200), other: colourReport.other.slice(0, 100), unreadable: colourReport.unreadable.slice(0, 100) },
                masterAfterSwap: { localRemaining: leftLocal, styleDerivedRemaining: leftStyled, derivedFromStyles: post.derivedFromStyles, counts: post.counts, oversetFrames: overAfter },
                offColourItems: swr.offColourItems, remapScope: REMAP_SCOPE, mismatches: mismatches, warnings: warnings });`,
            dry ? { prelude: CT_PRELUDE } : { prelude: CT_PRELUDE, undoName: "theme_chapter", mutating: true }
          );
        }),
    },
  };
}
